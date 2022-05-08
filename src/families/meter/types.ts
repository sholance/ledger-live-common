import { BigNumber } from "bignumber.js";
import type {
  TransactionCommon,
  TransactionCommonRaw,
} from "../../types/transaction";

export type Transaction = TransactionCommon & {
  family: "meter";
  fees: BigNumber | null | undefined;
};
export type TransactionRaw = TransactionCommonRaw & {
  family: "meter";
  fees: string | null | undefined;
};
