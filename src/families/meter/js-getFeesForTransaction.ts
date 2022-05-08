import { BigNumber } from "bignumber.js";
import { Account, Transaction } from "../../types";
import { meterKit } from "./api/sdk";

const getFeesForTransaction = async ({
  account,
  transaction,
}: {
  account: Account;
  transaction: Transaction;
}): Promise<BigNumber> => {
  const { amount } = transaction;
  const kit = meterKit();

  // A workaround - estimating gas throws an error if value > funds
  const value = transaction.useAllAmount
    ? account.spendableBalance
    : BigNumber.minimum(amount, account.spendableBalance);

  const meterToken = await kit.contracts.getGoldToken();

  const meterTransaction = {
    from: account.freshAddress,
    to: meterToken.address,
    data: meterToken
      .transfer(transaction.recipient, value.toFixed())
      .txo.encodeABI(),
  };

  const gasPrice = new BigNumber(await kit.connection.gasPrice());
  const gas = await kit.connection.estimateGasWithInflationFactor(
    meterTransaction
  );

  return gasPrice.times(gas);
};

export default getFeesForTransaction;
