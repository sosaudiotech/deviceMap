// db.js (ESM, LowDB v3) — supports overriding devices path via MAP_DEVICES_PATH env var
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';


const __dirname = path.dirname(fileURLToPath(import.meta.url));


const defaultDevicesFile = path.join(__dirname, 'data', 'devices.json');
const devicesFile = process.env.MAP_DEVICES_PATH && fs.existsSync(process.env.MAP_DEVICES_PATH)
? process.env.MAP_DEVICES_PATH
: defaultDevicesFile;


const floorsFile = path.join(__dirname, 'data', 'floors.json');


export async function getDB() {
// devices
const devicesAdapter = new JSONFile(devicesFile);
const devices = new Low(devicesAdapter, { devices: [] });
await devices.read();
devices.data ||= { devices: [] };


// floors
const floorsAdapter = new JSONFile(floorsFile);
const floors = new Low(floorsAdapter, { floors: [] });
await floors.read();
floors.data ||= { floors: [] };


return { devices, floors, paths: { devicesFile, floorsFile } };
}