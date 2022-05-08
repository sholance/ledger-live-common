import { Transaction } from "./types";
import { BigNumber } from "bignumber.js";

const createTransaction = (): Transaction => ({
  family: "meter",
  amount: new BigNumber(0),
  recipient: "",
  useAllAmount: false,
  fees: null,
});

export default createTransaction;
