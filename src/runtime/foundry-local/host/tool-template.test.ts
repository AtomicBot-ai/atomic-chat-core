import { describe, expect, it } from 'vitest'
import { repairFoundryToolTemplate } from './tool-template.js'

describe('repairFoundryToolTemplate', () => {
  it('keeps Gemma tool results after the canonical call in assistant content', () => {
    const original = `{{ tool['function']['name'] }}
{%- set ns_tr_out = namespace(flag=false) -%}
{%- if message.get('tool_responses') -%}
{%- elif message.get('tool_calls') -%}
{%- for tc in message.get('tool_calls') -%}
{%- endfor -%}
{%- endif -%}
{%- set captured_content -%}
            {%- if message.get('content') is string -%}
{{ message['content'] }}
{%- endif -%}
{%- endset -%}`
    const fixed = repairFoundryToolTemplate('gemma4', original)
    expect(fixed).toContain("(tool['function'] if tool['function'] else tool)['name']")
    expect(fixed).toContain("elif message.get('tool_calls') or atomic_canonical_call")
    expect(fixed).toContain("for tc in message.get('tool_calls') or []")
    expect(fixed.indexOf("strip_thinking(message['content'])")).toBeLessThan(fixed.indexOf('set ns_tr_out'))
    expect(repairFoundryToolTemplate('gemma4', fixed)).toBe(fixed)
  })

  it('lets Mistral Nemo retain and quote an opaque OpenAI tool call ID', () => {
    const original = `{%- if not message.tool_call_id is defined or message.tool_call_id|length != 9 %}
{{- raise_exception("Tool call IDs should be alphanumeric strings with length 9!") }}
{%- endif %}
{{- '"call_id": "' + message.tool_call_id + '"}[/TOOL_RESULTS]' }}`
    const fixed = repairFoundryToolTemplate('mistral', original)
    expect(fixed).toContain('if not message.tool_call_id is defined %}')
    expect(fixed).toContain('(message.tool_call_id | tojson)')
    expect(fixed).not.toContain('length != 9')
    expect(repairFoundryToolTemplate('mistral3', original)).toBe(original)
  })

  it('preserves SmolLM3 mode stripping using the available renderer methods', () => {
    const original = `{%- set custom_instructions = system_message.replace("/no_think", "").replace("/think", "").rstrip() -%}
{{- custom_instructions.replace("/system_override", "").rstrip() -}}`
    const fixed = repairFoundryToolTemplate('smollm3', original)
    expect(fixed).toContain('system_message.split("/no_think") | join("")')
    expect(fixed).toContain('.split("/think") | join("")')
    expect(fixed).toContain('custom_instructions.split("/system_override") | join("")')
    expect(repairFoundryToolTemplate('smollm3', fixed)).toBe(fixed)
  })
})
