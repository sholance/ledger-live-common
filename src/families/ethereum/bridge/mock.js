// @flow
import { BigNumber } from "bignumber.js";
import { NotEnoughBalance, InvalidAddress } from "@ledgerhq/errors";
import type { Transaction } from "../types";
import type { AccountBridge, CurrencyBridge } from "../../../types";
import { getEstimatedFees } from "../../../api/Fees"; // FIXME drop. not stable.
import { inferDeprecatedMethods } from "../../../bridge/deprecationUtils";
import {
  scanAccountsOnDevice,
  signAndBroadcast,
  startSync,
  isInvalidRecipient
} from "../../../bridge/mockHelpers";
import { getGasLimit } from "../transaction";

const defaultGetFees = (a, t: *) =>
  (t.gasPrice || BigNumber(0)).times(getGasLimit(t));

const createTransaction = (account): Transaction => ({
  family: "ethereum",
  amount: BigNumber(0),
  recipient: "",
  gasPrice: BigNumber(10000000000),
  userGasLimit: BigNumber(21000),
  estimatedGasLimit: BigNumber(21000),
  feeCustomUnit: account.currency.units[1],
  networkInfo: null,
  useAllAmount: false,
  subAccountId: null
});

const updateTransaction = (t, patch) => ({ ...t, ...patch });

const getTransactionStatus = (a, t) => {
  const tokenAccount = !t.subAccountId
    ? null
    : a.subAccounts && a.subAccounts.find(ta => ta.id === t.subAccountId);
  const account = tokenAccount || a;

  const useAllAmount = !!t.useAllAmount;

  const estimatedFees = defaultGetFees(a, t);

  const totalSpent = useAllAmount
    ? account.balance
    : tokenAccount
    ? BigNumber(t.amount)
    : BigNumber(t.amount).plus(estimatedFees);

  const amount = useAllAmount
    ? tokenAccount
      ? BigNumber(t.amount)
      : account.balance.minus(estimatedFees)
    : BigNumber(t.amount);

  const showFeeWarning = tokenAccount
    ? false
    : amount.gt(0) && estimatedFees.times(10).gt(amount);

  // Fill up transaction errors...
  let transactionError;
  if (totalSpent.gt(account.balance)) {
    transactionError = new NotEnoughBalance();
  }

  // Fill up recipient errors...
  let recipientError;
  let recipientWarning;
  if (isInvalidRecipient(t.recipient)) {
    recipientError = new InvalidAddress("");
  }

  return Promise.resolve({
    transactionError,
    recipientError,
    recipientWarning,
    showFeeWarning,
    estimatedFees,
    amount,
    totalSpent,
    useAllAmount
  });
};

const prepareTransaction = async (a, t) => {
  // TODO it needs to set the fee if not in t as well
  if (!t.networkInfo) {
    const { gas_price } = await getEstimatedFees(a.currency);
    return {
      ...t,
      networkInfo: {
        family: "ethereum",
        gasPrice: BigNumber(gas_price)
      }
    };
  }
  return t;
};

const getCapabilities = () => ({
  canSync: true,
  canSend: true
});

const accountBridge: AccountBridge<Transaction> = {
  createTransaction,
  updateTransaction,
  getTransactionStatus,
  prepareTransaction,
  startSync,
  signAndBroadcast,
  getCapabilities,
  ...inferDeprecatedMethods({
    name: "EthereumMockBridge",
    createTransaction,
    getTransactionStatus,
    prepareTransaction
  })
};

const currencyBridge: CurrencyBridge = {
  scanAccountsOnDevice
};

export default { currencyBridge, accountBridge };
