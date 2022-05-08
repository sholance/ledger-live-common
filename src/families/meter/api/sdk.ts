import { ContractKit, newKit } from "@celo/contractkit";
import { getEnv } from "../../../env";

let kit: ContractKit;
export const meterKit = () => {
  if (!kit) kit = newKit(getEnv("API_METER_NODE"));
  return kit;
};
