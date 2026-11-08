import type { CarrierAdapter, CarrierEnv } from "../../types.js";

/** An adapter the registry can choose: it also knows whether its secrets are set. */
export interface RegisteredAdapter extends CarrierAdapter {
  isConfigured(env: CarrierEnv): boolean;
}
