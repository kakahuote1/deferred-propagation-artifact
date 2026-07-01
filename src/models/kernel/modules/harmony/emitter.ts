import { canonicalInvokeSurfaceFromId, createBuiltinModuleAsset } from "../../moduleAssetHelpers";

const onCanonicalApiIds = [
    "api:official:openharmony:module=%40ohos.events.emitter:file=api%2F%40ohos.events.emitter.d.ts:export=default%3Aemitter:decl=namespace%3Aemitter:member=function%3Aon:invoke=call:params=0%3AInnerEvent%2C1%3ACallback%3CEventData%3E:ret=void",
    "api:official:openharmony:module=%40ohos.events.emitter:file=api%2F%40ohos.events.emitter.d.ts:export=default%3Aemitter:decl=namespace%3Aemitter:member=function%3Aon:invoke=call:params=0%3Astring%2C1%3ACallback%3CEventData%3E:ret=void",
    "api:official:openharmony:module=%40ohos.events.emitter:file=api%2F%40ohos.events.emitter.d.ts:export=default%3Aemitter:decl=namespace%3Aemitter:member=function%3Aon:invoke=call:params=0%3Astring%2C1%3ACallback%3CEventData%3E%20%7C%20Callback%3CGenericEventData%3CT%3E%3E:ret=void",
    "api:official:openharmony:module=%40ohos.events.emitter:file=api%2F%40ohos.events.emitter.d.ts:export=default%3Aemitter:decl=namespace%3Aemitter:member=function%3Aon:invoke=call:params=0%3Astring%2C1%3ACallback%3CGenericEventData%3CT%3E%3E:ret=void",
    "api:official:openharmony:module=%40ohos.events.emitter:file=api%2F%40ohos.events.emitter.d.ts:export=default%3Aemitter:decl=namespace%3Aemitter:member=function%3Aonce:invoke=call:params=0%3AInnerEvent%2C1%3ACallback%3CEventData%3E:ret=void",
    "api:official:openharmony:module=%40ohos.events.emitter:file=api%2F%40ohos.events.emitter.d.ts:export=default%3Aemitter:decl=namespace%3Aemitter:member=function%3Aonce:invoke=call:params=0%3Astring%2C1%3ACallback%3CEventData%3E:ret=void",
    "api:official:openharmony:module=%40ohos.events.emitter:file=api%2F%40ohos.events.emitter.d.ts:export=default%3Aemitter:decl=namespace%3Aemitter:member=function%3Aonce:invoke=call:params=0%3Astring%2C1%3ACallback%3CGenericEventData%3CT%3E%3E:ret=void",
];

const emitCanonicalApiIds = [
    "api:official:openharmony:module=%40ohos.events.emitter:file=api%2F%40ohos.events.emitter.d.ts:export=default%3Aemitter:decl=namespace%3Aemitter:member=function%3Aemit:invoke=call:params=0%3AInnerEvent%2C1%3A%3F%3AEventData:ret=void",
    "api:official:openharmony:module=%40ohos.events.emitter:file=api%2F%40ohos.events.emitter.d.ts:export=default%3Aemitter:decl=namespace%3Aemitter:member=function%3Aemit:invoke=call:params=0%3Astring%2C1%3A%3F%3AEventData:ret=void",
    "api:official:openharmony:module=%40ohos.events.emitter:file=api%2F%40ohos.events.emitter.d.ts:export=default%3Aemitter:decl=namespace%3Aemitter:member=function%3Aemit:invoke=call:params=0%3Astring%2C1%3A%3F%3AEventData%20%7C%20GenericEventData%3CT%3E:ret=void",
    "api:official:openharmony:module=%40ohos.events.emitter:file=api%2F%40ohos.events.emitter.d.ts:export=default%3Aemitter:decl=namespace%3Aemitter:member=function%3Aemit:invoke=call:params=0%3Astring%2C1%3A%3F%3AGenericEventData%3CT%3E:ret=void",
    "api:official:openharmony:module=%40ohos.events.emitter:file=api%2F%40ohos.events.emitter.d.ts:export=default%3Aemitter:decl=namespace%3Aemitter:member=function%3Aemit:invoke=call:params=0%3Astring%2C1%3AOptions%2C2%3A%3F%3AEventData:ret=void",
    "api:official:openharmony:module=%40ohos.events.emitter:file=api%2F%40ohos.events.emitter.d.ts:export=default%3Aemitter:decl=namespace%3Aemitter:member=function%3Aemit:invoke=call:params=0%3Astring%2C1%3AOptions%2C2%3A%3F%3AGenericEventData%3CT%3E:ret=void",
];

const emitterSurfaces = [
    ...onCanonicalApiIds,
    ...emitCanonicalApiIds,
].map(canonicalInvokeSurfaceFromId);

const harmonyEmitterModuleAsset = createBuiltinModuleAsset({
    id: "harmony.emitter",
    description: "Built-in Harmony event emitter bridges.",
    semanticsFamily: "harmony-event-emitter",
    role: "handoff",
    capability: "module.event-emitter",
    surfaces: emitterSurfaces,
    payload: {
        onCanonicalApiIds,
        emitCanonicalApiIds,
        maxCandidates: 8,
    },
});

export default harmonyEmitterModuleAsset;
