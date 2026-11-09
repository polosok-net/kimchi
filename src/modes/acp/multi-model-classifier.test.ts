import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentSideConnection, RequestPermissionRequest } from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Redirect settings.json I/O to a temp dir; never touch the real HOME.
const settingsDir = join(tmpdir(), `kimchi-acp-multi-model-test-${process.pid}`)
const settingsPath = join(settingsDir, "settings.json")

vi.mock("../../config/json.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../config/json.js")>()
	return {
		...original,
		readJson: (_path: string) => original.readJson(settingsPath),
		readJsonCached: (_path: string) => original.readJsonCached(settingsPath),
		writeJson: (_path: string, data: unknown) => original.writeJson(settingsPath, data),
	}
})

import { createCommandContext } from "../../extensions/__mocks__/context.js"
import { createExtensionApi } from "../../extensions/__mocks__/extension-api.js"
import { createModel, createModelRegistry } from "../../extensions/__mocks__/model-registry.js"
import { resetModelRolesCache } from "../../extensions/orchestration/model-roles.js"
import { registerModelRolesCommand } from "../../extensions/orchestration/model-roles-command.js"
import { resolveClassifierCandidates } from "../../extensions/permissions/classifier-models.js"
import { setAvailableModels } from "../../startup-context.js"
import { createAcpUIContext } from "./acp-ui-context.js"

const HAIKU = "kimchi-dev/claude-haiku"
const DEFAULTS = ["kimchi-dev/deepseek-v4-flash-0731", "kimchi-dev/glm-5.3-flash", "kimchi-dev/minimax-m3"]

describe("ACP /multi-model classifier role", () => {
	beforeEach(() => {
		mkdirSync(settingsDir, { recursive: true })
		writeFileSync(settingsPath, "{}")
		resetModelRolesCache()
		setAvailableModels([
			{
				slug: "claude-haiku",
				display_name: "Haiku",
				provider: "anthropic",
				reasoning: false,
				input_modalities: ["text"],
				is_serverless: true,
				limits: { context_window: 1000, max_output_tokens: 100 },
			},
		])
	})

	afterEach(() => {
		rmSync(settingsDir, { recursive: true, force: true })
		resetModelRolesCache()
		setAvailableModels([])
	})

	/** Drives the command through the real ACP UI context; the client answers via request_permission. */
	async function run(toggles: string[], cancelAfterToggles = false): Promise<{ menus: string[][] }> {
		const pending = [...toggles]
		const menus: string[][] = []
		let opened = false
		const requestPermission = vi.fn(async (params: RequestPermissionRequest) => {
			const names = params.options.map((o) => o.name)
			let pick: string | undefined
			if (params.toolCall.title === "Model Roles") {
				menus.push(names)
				if (!opened) {
					opened = true
					pick = names.find((n) => n.startsWith("Classifier:"))
				}
			} else {
				const next = pending.shift()
				if (next === undefined && cancelAfterToggles) {
					return { outcome: { outcome: "cancelled" as const } }
				}
				pick = next === undefined ? names.at(-1) : names.find((n) => n.includes(` ${next}`))
			}
			const option = params.options.find((o) => o.name === pick)
			return option
				? { outcome: { outcome: "selected" as const, optionId: option.optionId } }
				: { outcome: { outcome: "cancelled" as const } }
		})
		const conn = { requestPermission, extNotification: vi.fn(async () => {}) } as unknown as AgentSideConnection
		const ui = createAcpUIContext(conn, "session-1", undefined, () => {})

		const { api, getRegisteredCommand } = createExtensionApi()
		registerModelRolesCommand(api)
		const ctx = createCommandContext()
		Object.assign(ctx, { mode: "rpc", ui })
		await getRegisteredCommand("multi-model")?.handler("", ctx)
		return { menus }
	}

	const readSettings = (): { modelRoles?: Record<string, unknown> } => JSON.parse(readFileSync(settingsPath, "utf-8"))
	const registry = createModelRegistry([HAIKU, ...DEFAULTS].map((r) => createModel(r.split("/")[1])))

	it("lists the classifier role in the ACP select menu", async () => {
		const { menus } = await run([])
		expect(menus[0].some((o) => o.startsWith("Classifier:"))).toBe(true)
	})

	it("persists a classifier choice made over ACP and changes resolveClassifierCandidates", async () => {
		expect(resolveClassifierCandidates(registry).candidates[0]?.id).toBe("deepseek-v4-flash-0731")
		await run([HAIKU, ...DEFAULTS])
		expect(readSettings().modelRoles?.classifier).toEqual(HAIKU)
		expect(resolveClassifierCandidates(registry).candidates.map((m) => m.id)).toEqual(["claude-haiku"])
	})

	it("leaves settings and candidates untouched when the client cancels mid-toggle", async () => {
		await run([HAIKU, DEFAULTS[0]], true)
		expect(readSettings().modelRoles?.classifier).toBeUndefined()
		expect(resolveClassifierCandidates(registry).candidates.map((m) => `kimchi-dev/${m.id}`)).toEqual(DEFAULTS)
	})

	it("rejects an empty classifier selection and never persists an empty array", async () => {
		await run([...DEFAULTS])
		expect(readSettings().modelRoles?.classifier).toBeUndefined()
		expect(JSON.stringify(readSettings())).not.toContain("[]")
		expect(resolveClassifierCandidates(registry).candidates.map((m) => `kimchi-dev/${m.id}`)).toEqual(DEFAULTS)
	})
})
