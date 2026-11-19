import { describe, expect, it } from 'vitest'
import { version } from '../package.json'
import { APP_VERSION } from '../src/version'

describe('the version shown in the header', () => {
  it('comes from package.json', () => {
    expect(APP_VERSION).toBe(version)
  })
})
