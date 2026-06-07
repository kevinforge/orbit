/**
 * Hardware fingerprint collection module.
 * Collects MAC address, CPU info, and motherboard UUID to generate unique machine ID.
 */

import si from 'systeminformation';
import { createHash } from 'node:crypto';

/**
 * Collect hardware information and generate a unique machine ID.
 * Uses SHA256 hash of combined hardware identifiers.
 *
 * Priority order for hardware identifiers:
 * 1. MAC address (first non-virtual network interface)
 * 2. CPU UUID (fallback)
 * 3. Motherboard UUID (fallback)
 */
export async function generateMachineId(): Promise<string> {
  const identifiers: string[] = [];

  try {
    // Get network interfaces for MAC address
    const networks = await si.networkInterfaces();
    // Find first physical (non-virtual) interface
    const physicalInterface = networks.find(
      (iface) => iface.internal === false && !iface.virtual && iface.mac
    );
    if (physicalInterface?.mac) {
      identifiers.push(`mac:${physicalInterface.mac}`);
    }
  } catch {
    // Silently continue if network info unavailable
  }

  try {
    // Get CPU info for UUID
    const cpu = await si.cpu();
    if (cpu?.processors?.[0]?.id) {
      identifiers.push(`cpu:${cpu.processors[0].id}`);
    }
  } catch {
    // Silently continue if CPU info unavailable
  }

  try {
    // Get system (motherboard) info for UUID
    const system = await si.system();
    if (system?.uuid) {
      identifiers.push(`board:${system.uuid}`);
    }
  } catch {
    // Silently continue if system info unavailable
  }

  // Ensure we have at least one identifier
  if (identifiers.length === 0) {
    // Last resort: use hostname + platform as fallback
    const os = await import('node:os');
    identifiers.push(`fallback:${os.hostname()}:${os.platform()}:${os.arch()}`);
  }

  // Generate SHA256 hash of combined identifiers
  const combined = identifiers.join('|');
  return createHash('sha256').update(combined).digest('hex');
}

/**
 * Get raw hardware info for debugging or display purposes.
 */
export async function getHardwareInfo(): Promise<{
  mac?: string;
  cpuId?: string;
  boardUuid?: string;
}> {
  const result: { mac?: string; cpuId?: string; boardUuid?: string } = {};

  try {
    const networks = await si.networkInterfaces();
    const physicalInterface = networks.find(
      (iface) => iface.internal === false && !iface.virtual && iface.mac
    );
    if (physicalInterface?.mac) {
      result.mac = physicalInterface.mac;
    }
  } catch {
    // Ignore
  }

  try {
    const cpu = await si.cpu();
    if (cpu?.processors?.[0]?.id) {
      result.cpuId = cpu.processors[0].id;
    }
  } catch {
    // Ignore
  }

  try {
    const system = await si.system();
    if (system?.uuid) {
      result.boardUuid = system.uuid;
    }
  } catch {
    // Ignore
  }

  return result;
}
