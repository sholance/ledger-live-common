import { getTokenById } from "@ledgerhq/cryptoassets";
import {
  AmountRequired,
  InvalidAddress,
  InvalidAddressBecauseDestinationIsAlsoSource,
  NotEnoughBalance,
  RecipientRequired,
} from "@ledgerhq/errors";
import BigNumber from "bignumber.js";
import { findSubAccountById } from "../../account";
import type { Account } from "../../types";
import { ChainAPI } from "./api";
import {
  getMaybeTokenAccount,
  getMaybeVoteAccount,
  getStakeAccountAddressWithSeed,
  getStakeAccountMinimumBalanceForRentExemption,
} from "./api/chain/web3";
import {
  SolanaAccountNotFunded,
  SolanaAddressOffEd25519,
  SolanaMemoIsTooLong,
  SolanaTokenAccountHoldsAnotherToken,
  SolanaRecipientAssociatedTokenAccountWillBeFunded,
  SolanaTokenRecipientIsSenderATA,
  SolanaTokenAccounNotInitialized,
  SolanaInvalidValidator,
} from "./errors";
import {
  decodeAccountIdWithTokenAccountAddress,
  isEd25519Address,
  isValidBase58Address,
  MAX_MEMO_LENGTH,
} from "./logic";

import type {
  CommandDescriptor,
  StakeCreateAccountTransaction,
  StakeDelegateTransaction,
  StakeSplitTransaction,
  StakeUndelegateTransaction,
  StakeWithdrawTransaction,
  TokenCreateATATransaction,
  TokenRecipientDescriptor,
  TokenTransferTransaction,
  Transaction,
  TransactionModel,
  TransferCommand,
  TransferTransaction,
} from "./types";
import { assertUnreachable } from "./utils";

async function deriveCommandDescriptor(
  mainAccount: Account,
  tx: Transaction,
  api: ChainAPI
): Promise<CommandDescriptor> {
  const { model } = tx;

  switch (model.kind) {
    case "transfer":
      return deriveTransferCommandDescriptor(mainAccount, tx, model, api);
    case "token.transfer":
      return deriveTokenTransferCommandDescriptor(mainAccount, tx, model, api);
    case "token.createATA":
      return deriveCreateAssociatedTokenAccountCommandDescriptor(
        mainAccount,
        model,
        api
      );
    case "stake.createAccount":
      return deriveStakeCreateAccountCommandDescriptor(
        mainAccount,
        tx,
        model,
        api
      );
    case "stake.delegate":
      return deriveStakeDelegateCommandDescriptor(mainAccount, model, api);
    case "stake.undelegate":
      return deriveStakeUndelegateCommandDescriptor(mainAccount, model, api);
    case "stake.withdraw":
      return deriveStakeWithdrawCommandDescriptor(mainAccount, tx, model, api);
    case "stake.split":
      return deriveStakeSplitCommandDescriptor(mainAccount, tx, model, api);
    default:
      return assertUnreachable(model);
  }
}

const prepareTransaction = async (
  mainAccount: Account,
  tx: Transaction,
  api: ChainAPI
): Promise<Transaction> => {
  const txToDeriveFrom = updateModelIfSubAccountIdPresent(tx);

  const commandDescriptor = await deriveCommandDescriptor(
    mainAccount,
    txToDeriveFrom,
    api
  );

  const model: TransactionModel = {
    ...tx.model,
    commandDescriptor,
  };

  const preparedTx: Transaction = {
    ...tx,
    model,
  };

  // LLM requires this field to be truthy to show fees
  (preparedTx as any).networkInfo = true;

  return preparedTx;
};

const deriveTokenTransferCommandDescriptor = async (
  mainAccount: Account,
  tx: Transaction,
  model: TransactionModel & { kind: TokenTransferTransaction["kind"] },
  api: ChainAPI
): Promise<CommandDescriptor> => {
  const errors: Record<string, Error> = {};
  const warnings: Record<string, Error> = {};

  const subAccount = findSubAccountById(
    mainAccount,
    model.uiState.subAccountId
  );

  if (!subAccount || subAccount.type !== "TokenAccount") {
    throw new Error("subaccount not found");
  }

  await validateRecipientCommon(mainAccount, tx, errors, warnings, api);

  const memo = model.uiState.memo;

  if (typeof memo === "string" && memo.length > 0) {
    validateMemoCommon(memo, errors);
  }

  const tokenIdParts = subAccount.token.id.split("/");
  const mintAddress = tokenIdParts[tokenIdParts.length - 1];
  const mintDecimals = subAccount.token.units[0].magnitude;

  const senderAssociatedTokenAccountAddress =
    decodeAccountIdWithTokenAccountAddress(subAccount.id).address;

  if (
    !errors.recipient &&
    tx.recipient === senderAssociatedTokenAccountAddress
  ) {
    errors.recipient = new SolanaTokenRecipientIsSenderATA();
  }

  const defaultRecipientDescriptor: TokenRecipientDescriptor = {
    shouldCreateAsAssociatedTokenAccount: false,
    tokenAccAddress: "",
    walletAddress: "",
  };

  const recipientDescriptorOrError = errors.recipient
    ? defaultRecipientDescriptor
    : await getTokenRecipient(tx.recipient, mintAddress, api);

  if (!errors.recipient && recipientDescriptorOrError instanceof Error) {
    errors.recipient = recipientDescriptorOrError;
  }

  const recipientDescriptor: TokenRecipientDescriptor =
    recipientDescriptorOrError instanceof Error
      ? defaultRecipientDescriptor
      : recipientDescriptorOrError;

  // TODO: check if SOL balance enough to pay fees
  const txFee = (await api.getTxFeeCalculator()).lamportsPerSignature;
  const assocAccRentExempt =
    recipientDescriptor.shouldCreateAsAssociatedTokenAccount
      ? await api.getAssocTokenAccMinNativeBalance()
      : 0;

  if (recipientDescriptor.shouldCreateAsAssociatedTokenAccount) {
    warnings.recipient =
      new SolanaRecipientAssociatedTokenAccountWillBeFunded();
  }

  if (!tx.useAllAmount && tx.amount.lte(0)) {
    errors.amount = new AmountRequired();
  }

  const txAmount = tx.useAllAmount
    ? subAccount.spendableBalance.toNumber()
    : tx.amount.toNumber();

  if (!errors.amount && txAmount > subAccount.spendableBalance.toNumber()) {
    errors.amount = new NotEnoughBalance();
  }

  return {
    command: {
      kind: "token.transfer",
      ownerAddress: mainAccount.freshAddress,
      ownerAssociatedTokenAccountAddress: senderAssociatedTokenAccountAddress,
      amount: txAmount,
      mintAddress,
      mintDecimals,
      recipientDescriptor: recipientDescriptor,
      memo: model.uiState.memo,
    },
    fee: txFee + assocAccRentExempt,
    warnings,
    errors,
  };
};

async function getTokenRecipient(
  recipientAddress: string,
  mintAddress: string,
  api: ChainAPI
): Promise<TokenRecipientDescriptor | Error> {
  const recipientTokenAccount = await getMaybeTokenAccount(
    recipientAddress,
    api
  );

  if (recipientTokenAccount instanceof Error) {
    throw recipientTokenAccount;
  }

  if (recipientTokenAccount === undefined) {
    if (!isEd25519Address(recipientAddress)) {
      return new SolanaAddressOffEd25519();
    }

    const recipientAssociatedTokenAccountAddress =
      await api.findAssocTokenAccAddress(recipientAddress, mintAddress);

    const shouldCreateAsAssociatedTokenAccount = !(await isAccountFunded(
      recipientAssociatedTokenAccountAddress,
      api
    ));

    return {
      walletAddress: recipientAddress,
      shouldCreateAsAssociatedTokenAccount,
      tokenAccAddress: recipientAssociatedTokenAccountAddress,
    };
  } else {
    if (recipientTokenAccount.mint.toBase58() !== mintAddress) {
      return new SolanaTokenAccountHoldsAnotherToken();
    }
    if (recipientTokenAccount.state !== "initialized") {
      return new SolanaTokenAccounNotInitialized();
    }
  }

  return {
    walletAddress: recipientTokenAccount.owner.toBase58(),
    shouldCreateAsAssociatedTokenAccount: false,
    tokenAccAddress: recipientAddress,
  };
}

async function deriveCreateAssociatedTokenAccountCommandDescriptor(
  mainAccount: Account,
  model: TransactionModel & { kind: TokenCreateATATransaction["kind"] },
  api: ChainAPI
): Promise<CommandDescriptor> {
  const token = getTokenById(model.uiState.tokenId);
  const tokenIdParts = token.id.split("/");
  const mint = tokenIdParts[tokenIdParts.length - 1];

  const associatedTokenAccountAddress = await api.findAssocTokenAccAddress(
    mainAccount.freshAddress,
    mint
  );

  const txFee = (await api.getTxFeeCalculator()).lamportsPerSignature;
  const assocAccRentExempt = await api.getAssocTokenAccMinNativeBalance();

  return {
    fee: txFee + assocAccRentExempt,
    command: {
      kind: model.kind,
      mint: mint,
      owner: mainAccount.freshAddress,
      associatedTokenAccountAddress,
    },
    warnings: {},
    errors: {},
  };
}

async function deriveTransferCommandDescriptor(
  mainAccount: Account,
  tx: Transaction,
  model: TransactionModel & { kind: TransferTransaction["kind"] },
  api: ChainAPI
): Promise<CommandDescriptor> {
  const errors: Record<string, Error> = {};
  const warnings: Record<string, Error> = {};

  await validateRecipientCommon(mainAccount, tx, errors, warnings, api);

  const memo = model.uiState.memo;

  if (typeof memo === "string" && memo.length > 0) {
    validateMemoCommon(memo, errors);
  }

  const fee = (await api.getTxFeeCalculator()).lamportsPerSignature;

  const txAmount = tx.useAllAmount
    ? BigNumber.max(mainAccount.balance.minus(fee), 0)
    : tx.amount;

  if (tx.useAllAmount) {
    if (txAmount.eq(0)) {
      errors.amount = new NotEnoughBalance();
    }
  } else {
    if (txAmount.lte(0)) {
      errors.amount = new AmountRequired();
    } else if (txAmount.plus(fee).gt(mainAccount.balance)) {
      errors.amount = new NotEnoughBalance();
    }
  }
  const command: TransferCommand = {
    kind: "transfer",
    amount: txAmount.toNumber(),
    sender: mainAccount.freshAddress,
    recipient: tx.recipient,
    memo: model.uiState.memo,
  };

  return {
    command,
    fee,
    warnings,
    errors,
  };
}

async function deriveStakeCreateAccountCommandDescriptor(
  mainAccount: Account,
  tx: Transaction,
  model: TransactionModel & { kind: StakeCreateAccountTransaction["kind"] },
  api: ChainAPI
): Promise<CommandDescriptor> {
  const errors: Record<string, Error> = {};

  if (!tx.useAllAmount && tx.amount.lte(0)) {
    errors.amount = new AmountRequired();
  }

  const txFee = (await api.getTxFeeCalculator()).lamportsPerSignature;
  const stakeAccRentExemptAmount =
    await getStakeAccountMinimumBalanceForRentExemption(api);

  const fee = txFee + stakeAccRentExemptAmount;

  const amount = tx.useAllAmount
    ? BigNumber.max(mainAccount.balance.minus(fee), 0)
    : tx.amount;

  if (!errors.amount && mainAccount.balance.lt(amount.plus(fee))) {
    errors.amount = new NotEnoughBalance();
  }

  const { uiState } = model;
  const { delegate } = uiState;

  if (!isValidBase58Address(delegate.voteAccAddress)) {
    errors.voteAccAddress = new InvalidAddress();
  } else {
    const voteAcc = await getMaybeVoteAccount(delegate.voteAccAddress, api);

    if (voteAcc instanceof Error || voteAcc === undefined) {
      errors.voteAccAddress = new SolanaInvalidValidator();
    }
  }

  const { addr: stakeAccAddress, seed: stakeAccAddressSeed } =
    await nextStakeAccAddr(mainAccount);

  return {
    command: {
      kind: "stake.createAccount",
      amount: amount.toNumber(),
      stakeAccRentExemptAmount,
      fromAccAddress: mainAccount.freshAddress,
      stakeAccAddress,
      delegate,
      seed: stakeAccAddressSeed,
    },
    fee,
    warnings: {},
    errors,
  };
}

async function deriveStakeDelegateCommandDescriptor(
  mainAccount: Account,
  model: TransactionModel & { kind: StakeDelegateTransaction["kind"] },
  api: ChainAPI
): Promise<CommandDescriptor> {
  const errors: Record<string, Error> = {};

  const { uiState } = model;

  if (!isValidBase58Address(uiState.stakeAccAddr)) {
    errors.stakeAccAddr = new InvalidAddress();
  }

  if (!isValidBase58Address(uiState.voteAccAddr)) {
    errors.voteAccAddr = new InvalidAddress();
  } else {
    const voteAcc = await getMaybeVoteAccount(uiState.voteAccAddr, api);

    if (voteAcc instanceof Error || voteAcc === undefined) {
      errors.voteAccAddress = new SolanaInvalidValidator();
    }
  }

  const txFee = (await api.getTxFeeCalculator()).lamportsPerSignature;

  return {
    command: {
      kind: "stake.delegate",
      authorizedAccAddr: mainAccount.freshAddress,
      stakeAccAddr: uiState.stakeAccAddr,
      voteAccAddr: uiState.voteAccAddr,
    },
    fee: txFee,
    warnings: {},
    errors,
  };
}

async function deriveStakeUndelegateCommandDescriptor(
  mainAccount: Account,
  model: TransactionModel & { kind: StakeUndelegateTransaction["kind"] },
  api: ChainAPI
): Promise<CommandDescriptor> {
  const errors: Record<string, Error> = {};

  const { uiState } = model;

  if (!isValidBase58Address(uiState.stakeAccAddr)) {
    errors.stakeAccAddr = new InvalidAddress();
  }

  const txFee = (await api.getTxFeeCalculator()).lamportsPerSignature;

  return {
    command: {
      kind: "stake.undelegate",
      authorizedAccAddr: mainAccount.freshAddress,
      stakeAccAddr: uiState.stakeAccAddr,
    },
    fee: txFee,
    warnings: {},
    errors,
  };
}

async function deriveStakeWithdrawCommandDescriptor(
  mainAccount: Account,
  tx: Transaction,
  model: TransactionModel & { kind: StakeWithdrawTransaction["kind"] },
  api: ChainAPI
): Promise<CommandDescriptor> {
  const { uiState } = model;

  const stake = mainAccount.solanaResources?.stakes.find(
    (stake) => stake.stakeAccAddr === uiState.stakeAccAddr
  );

  if (stake === undefined) {
    throw new Error(
      `stake with account address <${uiState.stakeAccAddr}> not found`
    );
  }

  if (stake.withdrawable !== tx.amount.toNumber()) {
    throw new Error(
      `expected stake withdrawable amount <${
        stake.withdrawable
      }> to match transaction amount <${tx.amount.toNumber()}>`
    );
  }

  //TODO: what is user balance is less then fee?
  const txFee = (await api.getTxFeeCalculator()).lamportsPerSignature;

  return {
    command: {
      kind: "stake.withdraw",
      authorizedAccAddr: mainAccount.freshAddress,
      stakeAccAddr: stake.stakeAccAddr,
      amount: stake.withdrawable,
      toAccAddr: mainAccount.freshAddress,
    },
    fee: txFee,
    warnings: {},
    errors: {},
  };
}

async function deriveStakeSplitCommandDescriptor(
  mainAccount: Account,
  tx: Transaction,
  model: TransactionModel & { kind: StakeSplitTransaction["kind"] },
  api: ChainAPI
): Promise<CommandDescriptor> {
  const errors: Record<string, Error> = {};

  // TODO: find stake account in the main acc when synced
  const { uiState } = model;

  // TODO: use all amount
  if (tx.amount.lte(0)) {
    errors.amount = new AmountRequired();
  }
  // TODO: else if amount > stake balance

  if (!isValidBase58Address(uiState.stakeAccAddr)) {
    errors.stakeAccAddr = new InvalidAddress();
  }

  mainAccount.solanaResources?.stakes ?? [];

  const commandFees = await getStakeAccountMinimumBalanceForRentExemption(api);

  const { addr: splitStakeAccAddr, seed: splitStakeAccAddrSeed } =
    await nextStakeAccAddr(mainAccount);

  return {
    command: {
      kind: "stake.split",
      authorizedAccAddr: mainAccount.freshAddress,
      stakeAccAddr: uiState.stakeAccAddr,
      amount: tx.amount.toNumber(),
      seed: splitStakeAccAddrSeed,
      splitStakeAccAddr,
    },
    fee: commandFees,
    warnings: {},
    errors: {},
  };
}

// if subaccountid present - it's a token transfer
function updateModelIfSubAccountIdPresent(tx: Transaction): Transaction {
  if (tx.subAccountId) {
    return {
      ...tx,
      model: {
        kind: "token.transfer",
        uiState: {
          ...tx.model.uiState,
          subAccountId: tx.subAccountId,
        },
      },
    };
  }

  return tx;
}

async function isAccountFunded(
  address: string,
  api: ChainAPI
): Promise<boolean> {
  const balance = await api.getBalance(address);
  return balance > 0;
}

async function nextStakeAccAddr(account: Account, base = "stake") {
  const usedStakeAccAddrs = (account.solanaResources?.stakes ?? []).map(
    (s) => s.stakeAccAddr
  );

  return nextStakeAccAddrRoutine(
    account.freshAddress,
    new Set(usedStakeAccAddrs),
    base,
    0
  );
}

async function nextStakeAccAddrRoutine(
  fromAddress: string,
  usedAddresses: Set<string>,
  base: string,
  idx: number
): Promise<{
  seed: string;
  addr: string;
}> {
  const seed = `${base}:${idx}`;
  const addr = await getStakeAccountAddressWithSeed({
    fromAddress,
    seed,
  });

  return usedAddresses.has(addr)
    ? nextStakeAccAddrRoutine(fromAddress, usedAddresses, base, idx + 1)
    : {
        seed,
        addr,
      };
}

async function validateRecipientCommon(
  mainAccount: Account,
  tx: Transaction,
  errors: Record<string, Error>,
  warnings: Record<string, Error>,
  api: ChainAPI
) {
  if (!tx.recipient) {
    errors.recipient = new RecipientRequired();
  } else if (mainAccount.freshAddress === tx.recipient) {
    errors.recipient = new InvalidAddressBecauseDestinationIsAlsoSource();
  } else if (!isValidBase58Address(tx.recipient)) {
    errors.recipient = new InvalidAddress();
  } else {
    const recipientWalletIsUnfunded = !(await isAccountFunded(
      tx.recipient,
      api
    ));

    if (recipientWalletIsUnfunded) {
      warnings.recipient = new SolanaAccountNotFunded();
    }
    if (!isEd25519Address(tx.recipient)) {
      warnings.recipientOffCurve = new SolanaAddressOffEd25519();
    }
  }
}

function validateMemoCommon(memo: string, errors: Record<string, Error>) {
  const memoBytes = Buffer.from(memo, "utf-8");
  if (memoBytes.byteLength > MAX_MEMO_LENGTH) {
    errors.memo = errors.memo = new SolanaMemoIsTooLong(undefined, {
      maxLength: MAX_MEMO_LENGTH,
    });
    // LLM expects <transaction> as error key to disable continue button
    errors.transaction = errors.memo;
  }
}

export { prepareTransaction };
