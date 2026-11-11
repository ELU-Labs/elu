import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTeam, registeredProject, withHome } from './peer-helpers.mjs';
import { createTeam, team } from '../lib/peer/roster.mjs';
import { share, shares, teamProjects, joinedTeams, leaveProject } from '../lib/peer/index.mjs';

test('a project joined through a teammate’s team is left: its share ends and the membership stays', t => {
  const { teamId, member } = makeTeam(t);
  withHome(member.home, () => {
    const { root } = registeredProject(t);
    assert.deepEqual(joinedTeams(root), [], 'a project that is not shared is my own');
    share(root, { teams: [teamId] });
    assert.deepEqual(joinedTeams(root), [{ id: teamId, name: 'core' }]);
    assert.deepEqual(leaveProject(root), [{ id: teamId, name: 'core' }]);
    assert.deepEqual(shares(), []); assert.deepEqual(teamProjects(), {});
    assert.equal(team(teamId).members.some(row => row.key === member.identity.key && !row.removed), true, 'still on the team');
    assert.deepEqual(joinedTeams(root), []);
    assert.throws(() => leaveProject(root), /was not joined through a team/);
  });
});

test('a project of a team I founded is my own, also when a team I joined has it too', t => {
  const { teamId, founder, member } = makeTeam(t);
  withHome(founder.home, () => {
    const { root } = registeredProject(t);
    share(root, { teams: [teamId] });
    assert.deepEqual(joinedTeams(root), []);
    assert.throws(() => leaveProject(root), /was not joined through a team/);
    assert.equal(shares().length, 1);
  });
  withHome(member.home, () => {
    const { root } = registeredProject(t), mine = createTeam(member.identity, 'side');
    share(root, { teams: [teamId, mine.id] });
    assert.deepEqual(joinedTeams(root), []);
    assert.equal(shares().length, 1); assert.equal(Object.keys(teamProjects()).length, 2);
  });
});
