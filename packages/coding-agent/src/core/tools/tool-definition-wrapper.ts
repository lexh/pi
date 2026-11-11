import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import type { ExtensionToolContext, ToolDefinition } from "../extensions/types.ts";
import { currentManagedCall, type ManagedCallContext, managedActivity } from "../managed-process-context.ts";

/**
 * An `AgentTool` with a TypeBox parameter schema whose `execute` and `prepareArguments` are typed by TypeBox's
 * `Static`, as the built-in tools are (pi-agent-core types `params` through pi-schema, which maps only the common
 * TypeBox kinds). Spreads into a `ToolDefinition` of the same schema.
 */
export type TypeBoxAgentTool<TParams extends TSchema = TSchema, TDetails = any> = Omit<
	AgentTool<TParams, TDetails>,
	"prepareArguments" | "execute"
> & {
	prepareArguments?: (args: unknown) => Static<TParams>;
	execute: (
		toolCallId: string,
		params: Static<TParams>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
};

/** Creates the context for one tool call. */
export type ToolContextFactory = (toolCallId: string, signal: AbortSignal | undefined) => ExtensionToolContext;

/**
 * Allocates or inherits the managed process scope of one tool call. It is invoked synchronously, once per execute,
 * before the context is created or anything is awaited.
 */
export type ManagedContextFactory = (toolCallId: string) => ManagedCallContext | undefined;

/**
 * Wrap a ToolDefinition into an AgentTool for the core runtime. Without `managedFactory` a call inherits the
 * enclosing managed scope, if any, instead of allocating another attempt.
 */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: ToolContextFactory,
	managedFactory?: ManagedContextFactory,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		outputSchema: definition.outputSchema,
		constrainedSampling: definition.constrainedSampling,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate, ctx?: ExtensionToolContext) => {
			const created = managedFactory?.(toolCallId);
			const managed = created ?? currentManagedCall();
			if (!managed) {
				return definition.execute(
					toolCallId,
					params,
					signal,
					onUpdate,
					ctx ?? (ctxFactory?.(toolCallId, signal) as ExtensionToolContext),
				);
			}
			// A service stop cancels the call through this controller.
			const controller = new AbortController();
			const effectiveSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
			const context = ctx ?? (ctxFactory?.(toolCallId, effectiveSignal) as ExtensionToolContext);
			return managedActivity(
				managed,
				() => controller.abort(),
				() => definition.execute(toolCallId, params, effectiveSignal, onUpdate, context),
			).finally(() => {
				// Only an attempt allocated for this very call ends with it.
				if (created?.standalone) created.attempt.registry.end(created.attempt);
			});
		},
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: ToolContextFactory,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		outputSchema: tool.outputSchema,
		constrainedSampling: tool.constrainedSampling,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
