import { OffchainState, OffchainStateCommitments } from './offchain-state.js';
import { PublicKey } from '../../provable/crypto/signature.js';
import { UInt64 } from '../../provable/int.js';
import { SmartContract, method } from '../zkapp.js';
import { Mina, State, state } from '../../../index.js';
import assert from 'assert';

const offchainState = OffchainState({
  accounts: OffchainState.Map(PublicKey, UInt64),
  totalSupply: OffchainState.Field(UInt64),
});

class StateProof extends offchainState.Proof {}

// example contract that interacts with offchain state

class ExampleContract extends SmartContract {
  // TODO could have sugar for this like
  // @OffchainState.commitment offchainState = OffchainState.Commitment();
  @state(OffchainStateCommitments) offchainState = State(
    OffchainStateCommitments.empty()
  );

  @method
  async createAccount(address: PublicKey, amountToMint: UInt64) {
    offchainState.fields.accounts.set(address, amountToMint);

    // TODO using `update()` on the total supply means that this method
    // can only be called once every settling cycle
    let totalSupplyOption = await offchainState.fields.totalSupply.get();
    let totalSupply = totalSupplyOption.orElse(0n);

    offchainState.fields.totalSupply.update({
      from: totalSupplyOption,
      to: totalSupply.add(amountToMint),
    });
  }

  @method
  async transfer(from: PublicKey, to: PublicKey, amount: UInt64) {
    let fromOption = await offchainState.fields.accounts.get(from);
    let fromBalance = fromOption.assertSome('sender account exists');

    let toOption = await offchainState.fields.accounts.get(to);
    let toBalance = toOption.orElse(0n);

    /**
     * Update both accounts atomically.
     *
     * This is safe, because both updates will only be accepted if both previous balances are still correct.
     */
    offchainState.fields.accounts.update(from, {
      from: fromOption,
      to: fromBalance.sub(amount),
    });
    offchainState.fields.accounts.update(to, {
      from: toOption,
      to: toBalance.add(amount),
    });
  }

  @method.returns(UInt64)
  async getSupply() {
    return (await offchainState.fields.totalSupply.get()).orElse(0n);
  }

  @method.returns(UInt64)
  async getBalance(address: PublicKey) {
    return (await offchainState.fields.accounts.get(address)).orElse(0n);
  }

  @method
  async settle(proof: StateProof) {
    await offchainState.settle(proof);
  }
}

// test code below

// setup
const proofsEnabled = true;

const Local = await Mina.LocalBlockchain({ proofsEnabled });
Mina.setActiveInstance(Local);

let [sender, receiver, contractAccount] = Local.testAccounts;
let contract = new ExampleContract(contractAccount);
offchainState.setContractInstance(contract);

if (proofsEnabled) {
  console.time('compile program');
  await offchainState.compile();
  console.timeEnd('compile program');
  console.time('compile contract');
  await ExampleContract.compile();
  console.timeEnd('compile contract');
}

// deploy and create first account

console.time('deploy');
await Mina.transaction(sender, async () => {
  await contract.deploy();
})
  .sign([sender.key, contractAccount.key])
  .prove()
  .send();
console.timeEnd('deploy');

// create first account

console.time('create account');
await Mina.transaction(sender, async () => {
  await contract.createAccount(sender, UInt64.from(1000));
})
  .sign([sender.key])
  .prove()
  .send();
console.timeEnd('create account');

// settle

console.time('settlement proof 1');
let proof = await offchainState.createSettlementProof();
console.timeEnd('settlement proof 1');

console.time('settle 1');
await Mina.transaction(sender, () => contract.settle(proof))
  .sign([sender.key])
  .prove()
  .send();
console.timeEnd('settle 1');

// check balance and supply
await checkAgainstSupply(1000n);

// transfer

console.time('transfer');
await Mina.transaction(sender, () =>
  contract.transfer(sender, receiver, UInt64.from(100))
)
  .sign([sender.key])
  .prove()
  .send();
console.timeEnd('transfer');

// settle

console.time('settlement proof 2');
proof = await offchainState.createSettlementProof();
console.timeEnd('settlement proof 2');

console.time('settle 2');
await Mina.transaction(sender, () => contract.settle(proof))
  .sign([sender.key])
  .prove()
  .send();
console.timeEnd('settle 2');

// check balance and supply
await checkAgainstSupply(1000n);

// test helper

async function checkAgainstSupply(expectedSupply: bigint) {
  let supply = (await contract.getSupply()).toBigInt();
  assert.strictEqual(supply, expectedSupply);

  let balanceSender = (await contract.getBalance(sender)).toBigInt();
  let balanceReceiver = (await contract.getBalance(receiver)).toBigInt();

  console.log('balance (sender)', balanceSender);
  console.log('balance (recv)', balanceReceiver);
  assert.strictEqual(balanceSender + balanceReceiver, supply);
}
