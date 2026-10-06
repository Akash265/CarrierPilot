import type { Portal } from "../types";
import type { PortalAdapter } from "./types";
import { greenhouseV1 } from "./greenhouse";
import { leverV1 } from "./lever";

export { greenhouseV1, leverV1 };
export { SAFE_IDENTIFIER, type PortalAdapter, type SnapshotConfig, type StandardFieldRule, type FieldMatcher, type FormUrlInput } from "./types";

const ADAPTERS: Record<Portal, PortalAdapter> = { greenhouse: greenhouseV1, lever: leverV1 };

export const getAdapter = (portal: Portal): PortalAdapter => ADAPTERS[portal];
