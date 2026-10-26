import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStay, groupHandoffs } from '../public/product-view.js';

test('handoff window uses the next non-cancelled stay, including archived occupied history', () => {
  const stay = { id: 'current', property: 'one', end: '2027-01-01T10:00:00+05:00' };
  const stays = [
    { id: 'other-property', property: 'two', start: '2027-01-01T10:00:00+05:00', status: 'booked' },
    { id: 'cancelled', property: 'one', start: '2027-01-01T11:00:00+05:00', status: 'cancelled' },
    { id: 'later', property: 'one', start: '2027-01-01T16:00:00+05:00', status: 'booked' },
    { id: 'next', property: 'one', start: '2027-01-01T12:00:00+05:00', status: 'booked', archived: true },
    { id: 'before', property: 'one', start: '2027-01-01T09:00:00+05:00', status: 'booked' },
  ];
  assert.equal(nextStay(stay, stays).id, 'next');
  assert.equal(nextStay(stay, []), undefined);
});

test('open handoffs lead by deadline and checkout while completed and archived work stays in history', () => {
  const stays = [
    { id: 'completed', end: '2027-01-01T12:00:00+05:00' },
    { id: 'later', end: '2027-01-03T11:00:00+05:00' },
    { id: 'urgent', end: '2027-01-02T10:00:00+05:00' },
    { id: 'same-deadline', end: '2027-01-02T09:00:00+05:00' },
    { id: 'archived-work', end: '2027-01-02T08:00:00+05:00' },
  ];
  const tasks = [
    { stay: 'completed', status: 'done', due: '2027-01-01T13:00:00+05:00' },
    { stay: 'later', status: 'open', due: '2027-01-03T13:00:00+05:00' },
    { stay: 'urgent', status: 'done', due: '2027-01-02T11:00:00+05:00' },
    { stay: 'urgent', status: 'open', due: '2027-01-02T12:00:00+05:00' },
    { stay: 'same-deadline', status: 'open', due: '2027-01-02T12:00:00+05:00' },
    { stay: 'archived-work', status: 'open', due: '2027-01-02T08:30:00+05:00', archived: true },
  ];
  const groups = groupHandoffs(stays, tasks);
  assert.deepEqual(groups.current.map(stay => stay.id), ['same-deadline', 'urgent', 'later']);
  assert.deepEqual(groups.history.map(stay => stay.id), ['archived-work', 'completed']);
  assert.equal(groups.current.length + groups.history.length, stays.length);
  assert.equal(stays[0].id, 'completed');
  assert.equal(tasks.length, 6);
});
