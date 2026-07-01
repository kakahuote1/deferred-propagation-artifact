import type { AssetEndpoint } from "./EndpointTypes";

export interface EndpointSelectorRef {
    endpoint: AssetEndpoint;
    pathFrom?: AssetEndpoint;
    slotKind?: string;
    taintScope?: "self" | "contained-values";
}
