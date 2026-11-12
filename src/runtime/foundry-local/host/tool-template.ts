// The desktop template repair also recognizes this marker. The core hosts CLI and API models too.
const UNWRAPPED_FUNCTIONS =
  "{#- atomic-chat: Foundry Local hands tools and tool calls over without their 'function' wrapper -#}\n"

function repairGemma(template: string): string {
  if (!template.startsWith(UNWRAPPED_FUNCTIONS) && /\b[A-Za-z_][A-Za-z0-9_]*\['function'\]/.test(template)) {
    template =
      UNWRAPPED_FUNCTIONS +
      template
        .replace(/\b([A-Za-z_][A-Za-z0-9_]*)\['function'\]/g, "($1['function'] if $1['function'] else $1)")
        .replace(
          /\{\{-?\s*raise_exception\("chat_template: tool_calls\[\]\.function\.arguments must be a JSON object[^"]*"\)\s*-?\}\}/g,
          "{{- function['arguments'] | trim -}}"
        )
  }

  // Foundry's structured history stores the call in assistant content and omits the tool_calls array.
  const resultScan = "{%- elif message.get('tool_calls') -%}"
  const resultState = '{%- set ns_tr_out = namespace(flag=false) -%}'
  const matchCalls = "{%- for tc in message.get('tool_calls') -%}"
  const renderContent =
    "{%- set captured_content -%}\n            {%- if message.get('content') is string -%}"
  if (![resultState, resultScan, matchCalls, renderContent].every((part) => template.includes(part))) {
    return template
  }

  return template
    .replace(
      resultState,
      [
        "{%- set atomic_canonical_call = role == 'model' and not message.get('tool_calls') and message.get('content') is string and message['content'].split('<|tool_call>[{') | length > 1 and message['content'].split('<tool_call|>') | length > 1 -%}",
        '{%- if atomic_canonical_call -%}',
        "{{- strip_thinking(message['content']) -}}",
        '{%- endif -%}',
        resultState,
      ].join('\n')
    )
    .replace(resultScan, "{%- elif message.get('tool_calls') or atomic_canonical_call -%}")
    .replace(matchCalls, "{%- for tc in message.get('tool_calls') or [] -%}")
    .replace(
      renderContent,
      [
        '{%- set captured_content -%}',
        '{%- if atomic_canonical_call -%}',
        "{%- elif message.get('content') is string -%}",
      ].join('\n')
    )
}

/** Adapt catalog templates that reject Foundry's own tool transcript or renderer. */
export function repairFoundryToolTemplate(modelType: string, template: string): string {
  switch (modelType) {
    case 'gemma4':
      return repairGemma(template)
    case 'mistral':
      // Keep the external call ID intact so the reply still refers to the original call.
      return template
        .replace(' or tool_call.id|length != 9', '')
        .replace(' or message.tool_call_id|length != 9', '')
        .replaceAll(
          'Tool call IDs should be alphanumeric strings with length 9!',
          'A tool call ID is required.'
        )
        .replace(
          `'"call_id": "' + message.tool_call_id + '"}[/TOOL_RESULTS]'`,
          `'"call_id": ' + (message.tool_call_id | tojson) + '}[/TOOL_RESULTS]'`
        )
        .replace(`', "id": "' + tool_call.id + '"}'`, `', "id": ' + (tool_call.id | tojson) + '}'`)
    case 'smollm3':
      // Minja has split and join, but neither the replace method nor the replace filter.
      return template
        .replace(
          'system_message.replace("/no_think", "").replace("/think", "").rstrip()',
          '((system_message.split("/no_think") | join("")).split("/think") | join("")).rstrip()'
        )
        .replace(
          'custom_instructions.replace("/system_override", "").rstrip()',
          '(custom_instructions.split("/system_override") | join("")).rstrip()'
        )
    default:
      return template
  }
}
