import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { findModelByRef } from "../../shared/model-ref.js"
import { DEFAULT_MODEL_ROLES, getModelRoles, normalizeRoleModels } from "../orchestration/model-roles.js"

/**
 * Resolves the classifier model ladder from the user-level `modelRoles.classifier`
 * setting (project settings are never read). A configured list fully replaces the
 * defaults: when none of its refs resolve, no candidates are returned.
 */
export function resolveClassifierCandidates(registry: ModelRegistry): {
	candidates: Model<Api>[]
	missingRefs: string[]
} {
	const refs = normalizeRoleModels(getModelRoles().classifier ?? DEFAULT_MODEL_ROLES.classifier ?? [])
	const candidates: Model<Api>[] = []
	const missingRefs: string[] = []
	for (const ref of refs) {
		const model = findModelByRef(registry, ref)
		if (model) candidates.push(model)
		else missingRefs.push(ref)
	}
	return { candidates, missingRefs }
}
