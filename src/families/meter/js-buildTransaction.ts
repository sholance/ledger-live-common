import type { Transaction } from "./types";
import type { Account } from "../../types";
import { MeterTx } from "@celo/connect";
import { meterKit } from "./api/sdk";

const buildTransaction = async (account: Account, transaction: Transaction) => {
  const kit = meterKit();
  const { amount } = transaction;
  const value = transaction.useAllAmount
    ? account.spendableBalance.minus(transaction.fees || 0)
    : amount;

  const meterToken = await kit.contracts.getGoldToken();

  const meterTransaction = {
    from: account.freshAddress,
    to: meterToken.address,
    data: meterToken
      .transfer(transaction.recipient, value.toFixed())
      .txo.encodeABI(),
  };

  return {
    ...meterTransaction,
    chainId: await kit.connection.chainId(),
    nonce: await kit.connection.nonce(account.freshAddress),
    gas: await kit.connection.estimateGasWithInflationFactor(meterTransaction),
    gasPrice: await kit.connection.gasPrice(),
  } as MeterTx;
};

export default buildTransaction;
