/**
 * Hardware fingerprint collection module.
 * Collects MAC address, CPU info, disk serial, and motherboard UUID to generate unique machine ID.
 */

import si from 'systeminformation';
import { createHash } from 'node:crypto';

/**
 * Collect hardware information and generate a unique machine ID.
 * Uses SHA256 hash of combined hardware identifiers.
 *
 * Priority order for hardware identifiers:
 * 1. MAC address (first non-virtual network interface)
 * 2. CPU processor ID (unique identifier, not just brand name)
 * 3. Disk serial number (first physical drive)
 * 4. Motherboard UUID (fallback)
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
    // Get CPU info - combine multiple unique identifiers
    const cpu = await si.cpu();
    // Use combination of manufacturer, family, model, stepping for uniqueness
    // This is more unique than just brand name (same brand = same identifier problem)
    if (cpu?.manufacturer && cpu?.family && cpu?.model && cpu?.stepping) {
      identifiers.push(`cpu:${cpu.manufacturer}-${cpu.family}-${cpu.model}-${cpu.stepping}`);
    } else if (cpu?.brand && cpu?.manufacturer) {
      // Fallback to brand if detailed info unavailable
      identifiers.push(`cpu:${cpu.manufacturer}-${cpu.brand}`);
    }
  } catch {
    // Silently continue if CPU info unavailable
  }

  try {
    // Get disk info for serial number (more unique than CPU brand)
    const disks = await si.diskLayout();
    // Use first physical disk's serial number
    const physicalDisk = disks.find((disk) => disk.serialNum);
    if (physicalDisk?.serialNum) {
      identifiers.push(`disk:${physicalDisk.serialNum}`);
    }
  } catch {
    // Silently continue if disk info unavailable
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
  diskSerial?: string;
  boardUuid?: string;
}> {
  const result: { mac?: string; cpuId?: string; diskSerial?: string; boardUuid?: string } = {};

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
    // Use combination of manufacturer, family, model, stepping for uniqueness
    if (cpu?.manufacturer && cpu?.family && cpu?.model && cpu?.stepping) {
      result.cpuId = `${cpu.manufacturer}-${cpu.family}-${cpu.model}-${cpu.stepping}`;
    } else if (cpu?.brand && cpu?.manufacturer) {
      result.cpuId = `${cpu.manufacturer}-${cpu.brand}`;
    }
  } catch {
    // Ignore
  }

  try {
    const disks = await si.diskLayout();
    const physicalDisk = disks.find((disk) => disk.serialNum);
    if (physicalDisk?.serialNum) {
      result.diskSerial = physicalDisk.serialNum;
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
