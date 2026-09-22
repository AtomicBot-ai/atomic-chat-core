/**
 * Reading this machine's network: its interfaces, and the address it would use to reach the
 * internet. The selection over what they return is pure and lives in `lan.ts`.
 */

import { createSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { selectLanAddresses, sortInterfaceAddresses } from './lan.js'
import type { InterfaceAddress } from './lan.js'

/** How long the default-route lookup may take before the list is shown without it. */
const DEFAULT_ROUTE_TIMEOUT_MS = 1000

/** The part of a UDP socket the default-route lookup uses; a seam for a machine with no network. */
export interface UdpProbeSocket {
  once(event: 'error', listener: (error: Error) => void): unknown
  connect(port: number, address: string, callback: () => void): void
  address(): { address: string }
  close(): void
}

export interface LanProbeDeps {
  interfaces?: () => ReturnType<typeof networkInterfaces>
  defaultRoute?: () => Promise<string | undefined>
}

/** Every IPv4 address of every interface, in a stable order. */
export function interfaceAddresses(
  read: () => ReturnType<typeof networkInterfaces> = networkInterfaces
): InterfaceAddress[] {
  const found: InterfaceAddress[] = []
  for (const [name, addresses] of Object.entries(read()))
    for (const entry of addresses ?? [])
      if (entry.family === 'IPv4') found.push({ name, address: entry.address })
  return sortInterfaceAddresses(found)
}

/**
 * The local address the OS would use to reach the internet. `connect` on a UDP socket only fixes
 * the local end; nothing is sent. `undefined` when there is no route, or no answer in time.
 */
export function defaultRouteAddress(
  timeoutMs = DEFAULT_ROUTE_TIMEOUT_MS,
  open: () => UdpProbeSocket = () => createSocket('udp4')
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = open()
    let settled = false
    const finish = (address: string | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // Never opened, or already closed.
      }
      resolve(address)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    timer.unref?.()
    socket.once('error', () => finish(undefined))
    try {
      socket.connect(80, '8.8.8.8', () => {
        try {
          finish(socket.address().address)
        } catch {
          finish(undefined)
        }
      })
    } catch {
      finish(undefined)
    }
  })
}

/** What to show under "reachable on your network", default-route address first. */
export async function lanAddresses(deps: LanProbeDeps = {}): Promise<string[]> {
  const defaultRoute = await (deps.defaultRoute ?? defaultRouteAddress)()
  return selectLanAddresses(interfaceAddresses(deps.interfaces), defaultRoute)
}
