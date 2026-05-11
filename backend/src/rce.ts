import type { ActionData, ActionResult, PermissionLevel } from "./types/rce";
import { CONT, ERROR_MSG_REFERENCE } from "./consts";
import { actions } from "./functions";
import { validate } from "jsonschema";
import { readConfig } from "./config/permissions";
import { CONFIG_PATH } from "./config/paths";
import { PermissionLevel as PermLevel } from "./types/rce";
import { ADAPT } from "./adaptive";

export async function RCEActionHandler(actionData: ActionData): Promise<void> {
    console.log(`Received action from Neuro: ${actionData.name}`, actionData.params);
    if (!CONT.docker) {
        CONT.neuro.sendContext(`Docker client not initialized, ${ERROR_MSG_REFERENCE}`, true);
        return;
    };

    const action = actions.find((a) => a.name === actionData.name);

    if (!action) {
        CONT.neuro.sendActionResult(actionData.id, true, 'Unknown action.');
        return;
    };

    const startedAt = Date.now()
    let adaptiveNiche = ADAPT.resolveNiche(actionData.name)
    let actionSucceeded = false

    // Permission backup: even if an action is still registered for any reason,
    // refuse execution if the persisted permissions disable it.
    try {
        const permissions = readConfig(actions, CONFIG_PATH)
        const permission = permissions[actionData.name] ?? action.defaultPermission ?? PermLevel.OFF
        if (permission === PermLevel.OFF) {
            const msg = `Action "${actionData.name}" is disabled by permissions.`
            CONT.logger.warn(msg)
            CONT.neuro.sendActionResult(actionData.id, false, msg)
            return;
        }

        const adaptiveDecision = ADAPT.evaluateAction(actionData.name, adaptiveNiche)
        adaptiveNiche = adaptiveDecision.niche
        if (!adaptiveDecision.allow) {
            const mode = adaptiveDecision.enforced ? 'enforced' : 'shadow'
            const msg = `Action "${actionData.name}" blocked by adaptive policy (${mode}): ${adaptiveDecision.reason}`
            CONT.logger.warn(msg)
            CONT.neuro.sendActionResult(actionData.id, false, msg)
            return
        }
    } catch (err) {
        CONT.logger.error('Permission check failed:', err)
        CONT.neuro.sendActionResult(actionData.id, true, `Failed to check your access to this action! ${ERROR_MSG_REFERENCE}`)
        return;
    }

    if (action.schema) {
        const result = validate(actionData.params, action.schema, { required: true });
        if (!result.valid) {
            const messagesArray: string[] = [];
            result.errors.map((erm) => {
                if (erm.stack.startsWith('instance.')) messagesArray.push(erm.stack.substring(9));
                else messagesArray.push(erm.stack);
            });
            if (messagesArray.length === 0) messagesArray.push('Unknown schema validation error.');
            const schemaFailures = `- ${messagesArray.join('\n- ')}`;
            const message = 'Action failed, your inputs did not pass schema validation due to these problems:\n\n' + schemaFailures + '\n\nPlease pay attention to the schema and the above errors if you choose to retry.';
            CONT.neuro.sendActionResult(actionData.id, false, message);
            return;
        }
    }

    if (action.validators) {
        for (const v of action.validators) {
            const result = await v(actionData);
            if (!result.success) {
                CONT.neuro.sendActionResult(actionData.id, !result.retry, result.message);
                return;
            }
        }
    }

    CONT.neuro.sendActionResult(actionData.id, true);

    try {
        const actionResult: ActionResult = await action.handler(actionData);
        actionSucceeded = actionResult.success
        if (!actionResult.success) CONT.logger.error(`Action ${actionData.name} failed! Full reason: ${actionResult.message}`)
        CONT.neuro.sendContext(actionResult.success ? actionResult.message : `Action failed: ${actionResult.message}`, actionResult.silent);
    } catch (erm) {
        CONT.neuro.sendContext(`Action threw an exception during execution! ${ERROR_MSG_REFERENCE}`)
    } finally {
        ADAPT.recordInteraction({
            actionName: actionData.name,
            niche: adaptiveNiche,
            success: actionSucceeded,
            latencyMs: Date.now() - startedAt,
        })
    }
    return;
}
