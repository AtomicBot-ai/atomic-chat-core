/**
 * Agent config writers. Each module registers itself with the registry at import time, so adding an
 * agent means adding a file and one import here.
 */
import './atomic-agent.js'
import './claude-code.js'
import './cline.js'
import './codex.js'
import './copilot.js'
import './droid.js'
import './dsh.js'
import './goose.js'
import './hermes.js'
import './kilo.js'
import './mimo.js'
import './muse.js'
import './openclaude.js'
import './openclaw.js'
import './opencode.js'
import './openhands.js'
import './pi.js'
import './poolside.js'
import './zcode.js'
import './zed.js'

export * from './registry.js'
