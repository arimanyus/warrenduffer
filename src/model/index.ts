import { cfg } from "../config.js";
import { JevModel, type Model } from "./jev.js";
import { MockModel } from "./mock.js";

export function createModel(): Model {
  return cfg.model === "jev" ? new JevModel() : new MockModel();
}

export type { Model, EvalResult, EvalAnswer } from "./jev.js";
