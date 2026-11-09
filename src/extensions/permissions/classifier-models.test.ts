import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createModel, createModelRegistry } from "../__mocks__/model-registry.js"
import { DEFAULT_MODEL_ROLES, type ModelRoles, normalizeRoleModels } from "../orchestration/model-roles.js"
import { resolveClassifierCandidates } from "./classifier-models.js"
import { loadConfig } from "./config.js"

const { classifier: _unset, ...unsetRoles } = DEFAULT_MODEL_ROLES
let userRoles: ModelRoles = unsetRoles

vi.mock("../orchestration/model-roles.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../orchestration/model-roles.js")>()
	return { ...original, getModelRoles: () => userRoles }
})

const primary = createModel("deepseek-v4-flash-0731")
const glm = createModel("glm-5.3-flash")
const fallback = createModel("minimax-m3")
const [primaryRef, glmRef, fallbackRef] = normalizeRoleModels(DEFAULT_MODEL_ROLES.classifier ?? [])
const a = createModel("a", "x")
const b = createModel("b", "x")

beforeEach(() => {
	userRoles = unsetRoles
})

describe("resolveClassifierCandidates", () => {
	it("pins the ordered default ladder", () => {
		expect([primaryRef, glmRef, fallbackRef]).toEqual([
			"kimchi-dev/deepseek-v4-flash-0731",
			"kimchi-dev/glm-5.3-flash",
			"kimchi-dev/minimax-m3",
		])
	})

	it.each([
		{ models: [fallback, glm, primary], candidates: [primary, glm, fallback], missingRefs: [] },
		{ models: [fallback, glm], candidates: [glm, fallback], missingRefs: [primaryRef] },
		{ models: [], candidates: [], missingRefs: [primaryRef, glmRef, fallbackRef] },
		{
			models: [createModel(primary.id, "custom"), createModel(glm.id, "custom"), createModel(fallback.id, "custom")],
			candidates: [],
			missingRefs: [primaryRef, glmRef, fallbackRef],
		},
	])("uses the defaults when unset (models $models)", ({ models, candidates, missingRefs }) => {
		expect(resolveClassifierCandidates(createModelRegistry(models))).toEqual({ candidates, missingRefs })
	})

	it("honors the configured order", () => {
		userRoles = { ...unsetRoles, classifier: ["x/b", "x/a"] }
		expect(resolveClassifierCandidates(createModelRegistry([a, b]))).toEqual({ candidates: [b, a], missingRefs: [] })
	})

	it("reports missing refs while keeping resolved ones", () => {
		userRoles = { ...unsetRoles, classifier: ["x/b", "x/gone", "x/a"] }
		expect(resolveClassifierCandidates(createModelRegistry([a, b]))).toEqual({
			candidates: [b, a],
			missingRefs: ["x/gone"],
		})
	})

	it("does not fall back to the defaults when every configured ref is missing", () => {
		userRoles = { ...unsetRoles, classifier: ["x/gone", "x/nope"] }
		expect(resolveClassifierCandidates(createModelRegistry([primary, glm, fallback]))).toEqual({
			candidates: [],
			missingRefs: ["x/gone", "x/nope"],
		})
	})

	describe("project scope isolation", () => {
		let cwd: string
		beforeEach(() => {
			cwd = mkdtempSync(join(tmpdir(), "kimchi-classifier-models-"))
			mkdirSync(join(cwd, ".pi"))
			mkdirSync(join(cwd, ".kimchi"))
			writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ modelRoles: { classifier: "evil/model" } }))
			const body = JSON.stringify({ classifier: ["evil/model"], classifierModels: ["evil/model"] })
			writeFileSync(join(cwd, ".kimchi", "permissions.json"), body)
			writeFileSync(join(cwd, ".kimchi", "permissions.local.json"), body)
		})
		afterEach(() => rmSync(cwd, { recursive: true, force: true }))

		it("leaves candidates unchanged and never adopts project classifier keys", () => {
			const evil = createModel("model", "evil")
			const registry = createModelRegistry([evil, primary, glm, fallback])
			const before = resolveClassifierCandidates(registry)
			const { loaded } = loadConfig({ cwd })
			expect(JSON.stringify(loaded.config)).not.toContain("evil/model")
			expect(resolveClassifierCandidates(registry)).toEqual(before)
			expect(before.candidates).toEqual([primary, glm, fallback])
		})
	})
})
