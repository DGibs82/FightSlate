import test from 'node:test';import assert from 'node:assert/strict';import {listEvents,listDeveloping,seed} from '../lib/store.mjs';
test('current snapshot loads',async()=>{const e=await listEvents();assert.ok(e.length>=20);assert.equal(e[0].date,'2026-07-25')});
test('developing matchups stay separate',async()=>{const d=await listDeveloping();assert.ok(d.some(x=>x.id==='haney-stevenson'));assert.ok(!(await listEvents()).some(x=>x.id==='haney-stevenson'))});
test('file seed works',async()=>{const s=await seed();assert.equal(s.mode,'file')});
