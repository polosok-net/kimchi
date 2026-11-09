import { describe, expect, it } from "vitest"
import { createModel } from "../__mocks__/model-registry.js"
import { DEFAULT_MODEL_ROLES, normalizeRoleModels } from "../orchestration/model-roles.js"
import { classifierHealth } from "./classifier-health.js"
import { PERMISSION_EVENTS } from "./permissions-events.js"
import type { ClassifierFailureCode, ClassifierResult } from "./types.js"

const DEFAULT_CLASSIFIER_REFS = normalizeRoleModels(DEFAULT_MODEL_ROLES.classifier ?? [])

const TAIL =
	" Check the classifier models in modelRoles.classifier (/multi-model or ~/.config/kimchi/harness/settings.json)."
const UNAVAILABLE =
	"Permissions classifier unavailable. Calls requiring classification need confirmation or are blocked without a UI." +
	TAIL

const primary = createModel("deepseek-v4-flash-0731")
const fallback = createModel("minimax-m3")
const healthy: ClassifierResult = { verdict: "safe", ok: true, reason: "fine", usedModelId: primary.id }

describe("classifierHealth", () => {
	it.each(["safe", "requires-confirmation"] as const)("treats primary %s as healthy", (verdict) => {
		expect(classifierHealth({ ...healthy, verdict }, [primary, fallback], [])).toBeUndefined()
	})

	it.each([
		{ candidates: [primary, fallback], missingRefs: [], usedModelId: fallback.id },
		{ candidates: [fallback], missingRefs: [DEFAULT_CLASSIFIER_REFS[0]], usedModelId: fallback.id },
		{ candidates: [primary], missingRefs: [DEFAULT_CLASSIFIER_REFS[1]], usedModelId: primary.id },
	])("reports successful fallback or reduced availability: $usedModelId", ({
		candidates,
		missingRefs,
		usedModelId,
	}) => {
		expect(classifierHealth({ ...healthy, usedModelId }, candidates, missingRefs)).toMatchObject({
			channel: PERMISSION_EVENTS.CLASSIFIER_DEGRADED,
			notifyKey: PERMISSION_EVENTS.CLASSIFIER_DEGRADED,
			payload: { usedModelId, missingRefs },
		})
	})

	it("reports only unavailable when all models are missing", () => {
		expect(
			classifierHealth(
				{ ...healthy, ok: false, usedModelId: undefined, failureCode: "no_candidates" },
				[],
				[...DEFAULT_CLASSIFIER_REFS],
			),
		).toMatchObject({
			channel: PERMISSION_EVENTS.CLASSIFIER_UNAVAILABLE,
			payload: { failureCode: "no_candidates", missingRefs: [...DEFAULT_CLASSIFIER_REFS] },
		})
	})

	it("does not label cancellation as an outage", () => {
		expect(classifierHealth({ ...healthy, ok: false, failureCode: "aborted" }, [], [])).toBeUndefined()
		const controller = new AbortController()
		controller.abort()
		expect(classifierHealth({ ...healthy, ok: false }, [], [], controller.signal)).toBeUndefined()
	})

	it.each<ClassifierFailureCode>([
		"no_api_key",
		"provider_error",
		"invalid_output",
		"auth_unavailable",
		"auth_timeout",
		"timeout",
		"budget_exhausted",
	])("never emits diagnostics containing secrets for %s", (failureCode) => {
		const health = classifierHealth(
			{ ...healthy, ok: false, reason: "SENTINEL_SECRET", failureCode },
			[primary],
			[DEFAULT_CLASSIFIER_REFS[1]],
		)
		expect(health?.payload).toEqual({ failureCode, missingRefs: [DEFAULT_CLASSIFIER_REFS[1]] })
		expect(JSON.stringify(health)).not.toContain("SENTINEL_SECRET")
	})

	it("selects actionable copy for no_api_key and generic copy otherwise", () => {
		const noKey = classifierHealth({ ...healthy, ok: false, failureCode: "no_api_key" }, [primary], [])
		expect(noKey?.message).toContain("KIMCHI_API_KEY")
		expect(noKey?.notifyKey).toBe(`${PERMISSION_EVENTS.CLASSIFIER_UNAVAILABLE}:no_api_key`)
		const other = classifierHealth({ ...healthy, ok: false, failureCode: "provider_error" }, [primary], [])
		expect(other?.message).not.toContain("KIMCHI_API_KEY")
		expect(other?.notifyKey).toBe(PERMISSION_EVENTS.CLASSIFIER_UNAVAILABLE)
		expect(other?.message).toBe(UNAVAILABLE)
		expect(noKey?.message).toBe(
			"Permissions classifier has no Kimchi API key configured. Set KIMCHI_API_KEY to enable auto-approval; calls requiring classification will keep asking for confirmation (or are blocked without a UI).",
		)
	})

	it.each<ClassifierFailureCode>(["provider_error", "timeout"])("uses classifier role copy for %s", (failureCode) => {
		expect(classifierHealth({ ...healthy, ok: false, failureCode }, [primary], [])?.message).toBe(UNAVAILABLE)
	})

	it("uses classifier role copy for no_candidates", () => {
		expect(classifierHealth({ ...healthy, ok: false, failureCode: "no_candidates" }, [], [])?.message).toBe(UNAVAILABLE)
	})

	it("uses classifier role copy when degraded", () => {
		expect(classifierHealth({ ...healthy, usedModelId: fallback.id }, [primary, fallback], [])?.message).toBe(
			"Permissions classifier is using a fallback model or has reduced model availability." + TAIL,
		)
	})
})
