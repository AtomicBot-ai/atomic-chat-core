import { expect, it } from 'vitest'
import { windowsManifest } from '../../../../test/helpers/flm-environment.js'
import { parseEnvironment } from './manifest.js'
import { supportedWindowsDriver } from './windows-driver.js'
it('pins all fields of the package the Windows helper can install', () => {
  const recipe = parseEnvironment(windowsManifest(), 'windows').recipes[0]!
  if (recipe.action !== 'windows.install-amd-npu') throw Error('bad fixture')
  expect(supportedWindowsDriver(recipe.driver)).toBe(true)
  for (const key of Object.keys(recipe.driver))
    expect(supportedWindowsDriver({ ...recipe.driver, [key]: 'substituted' })).toBe(false)
})
