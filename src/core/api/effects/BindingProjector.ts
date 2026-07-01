import type { AssetBinding, AssetEndpoint, SemanticEffectTemplate } from "../../assets/schema";
import type { ResolvedApiOccurrence } from "../occurrence";
import type { ApiEffectIdentity, ApiEffectInstance, ApiEffectRole, ResolvedEndpointBinding } from "../ApiOccurrenceIdentity";

export interface BindingProjectionInput {
    occurrence: ResolvedApiOccurrence;
    binding: AssetBinding;
    template: SemanticEffectTemplate;
    endpoint?: AssetEndpoint;
}

export interface EffectProjectionDiagnostic {
    kind: string;
    message: string;
}

export function projectBindingToEffect(input: BindingProjectionInput): ApiEffectInstance {
    const canonicalApiId = input.occurrence.canonicalApiId;
    if (!canonicalApiId) {
        throw new Error(`accepted API effect occurrence ${input.occurrence.occurrenceId} has no canonicalApiId`);
    }
    if (!input.binding.canonicalApiId) {
        throw new Error(`asset binding ${input.binding.bindingId} has no canonicalApiId`);
    }
    if (input.binding.canonicalApiId !== canonicalApiId) {
        throw new Error(
            `asset binding ${input.binding.bindingId} canonicalApiId does not match occurrence ${input.occurrence.occurrenceId}`,
        );
    }
    const role = apiEffectRoleFromBinding(input.binding);
    const identity: ApiEffectIdentity = {
        canonicalApiId,
        assetId: input.binding.assetId,
        surfaceId: input.binding.surfaceId,
        bindingId: input.binding.bindingId,
        effectTemplateId: input.template.id,
        role,
    };
    const endpointBindings = endpointBindingsFromTemplate(input.template, input.endpoint || input.binding.endpoint);
    const endpointStatus = endpointBindings.length > 0 ? "exact" : "unresolved";
    return {
        effectInstanceId: [
            "effect",
            input.occurrence.occurrenceId,
            input.binding.bindingId,
            input.template.id,
        ].join(":"),
        occurrenceId: input.occurrence.occurrenceId,
        rawOccurrenceId: input.occurrence.rawOccurrenceId,
        identity,
        endpointBindings,
        guardStatus: input.binding.guard ? "accepted" : "accepted",
        endpointStatus,
        acceptedForPropagation: input.occurrence.status === "accepted" && endpointStatus === "exact",
        diagnostics: endpointStatus === "exact"
            ? []
            : [{ kind: "endpoint_unresolved", message: "binding/template does not declare all required endpoints" }],
    };
}

function apiEffectRoleFromBinding(binding: AssetBinding): ApiEffectRole {
    if (binding.role === "source"
        || binding.role === "sink"
        || binding.role === "sanitizer"
        || binding.role === "transfer") {
        return binding.role;
    }
    if (binding.role === "entry") return "arkmain";
    return "module";
}

function endpointBindingsFromTemplate(
    template: SemanticEffectTemplate,
    bindingEndpoint?: AssetEndpoint,
): ApiEffectInstance["endpointBindings"] {
    if (template.kind === "rule.transfer") {
        const from = endpointBindingFromRuleValue(template.from, "from");
        const to = endpointBindingFromRuleValue(template.to, "to");
        if (!from || !to) return [];
        return [from, to];
    }
    const endpoint = bindingEndpoint || endpointFromTemplate(template);
    return endpoint ? [{ endpoint, status: "exact" }] : [];
}

function endpointFromTemplate(template: SemanticEffectTemplate): AssetEndpoint | undefined {
    switch (template.kind) {
        case "rule.source":
            return endpointFromRuleValue(template.value);
        case "rule.sink":
        case "rule.sanitizer":
            return template.value ? endpointFromRuleValue(template.value) : undefined;
        case "rule.transfer":
            return endpointFromRuleValue(template.to);
        case "handoff.put":
            return template.value;
        case "handoff.get":
            return template.target;
        case "entry.scheduleUnit":
            return template.unit;
        case "entry.frameworkInvoke":
            return template.target;
        default:
            return undefined;
    }
}

function endpointFromRuleValue(value: any): AssetEndpoint | undefined {
    if (!value || typeof value !== "object") return undefined;
    if (value.endpoint && typeof value.endpoint === "object") return value.endpoint as AssetEndpoint;
    if (value.base && typeof value.base === "object") return value as AssetEndpoint;
    return undefined;
}

function endpointBindingFromRuleValue(value: any, valueRef: string): ResolvedEndpointBinding | undefined {
    if (!value || typeof value !== "object") return undefined;
    if (value.endpoint && typeof value.endpoint === "object") {
        return {
            endpoint: value.endpoint as AssetEndpoint,
            pathFrom: value.pathFrom && typeof value.pathFrom === "object" ? value.pathFrom as AssetEndpoint : undefined,
            slotKind: typeof value.slotKind === "string" ? value.slotKind : undefined,
            taintScope: value.taintScope === "self" || value.taintScope === "contained-values" ? value.taintScope : undefined,
            valueRef,
            status: "exact",
        };
    }
    if (value.base && typeof value.base === "object") {
        return {
            endpoint: value as AssetEndpoint,
            valueRef,
            status: "exact",
        };
    }
    return undefined;
}
