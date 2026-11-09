import fs from 'fs';
import path from 'path';

test('ADR workflow checks out fork head commits without trying to write to fork branches', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/adr.yml'), 'utf8');
  expect(workflow).toContain('repository: ${{ github.event.pull_request.head.repo.full_name }}');
  expect(workflow).toContain('ref: ${{ github.event.pull_request.head.sha }}');
  expect(workflow).toContain('persist-credentials: ${{ github.event.pull_request.head.repo.full_name == github.repository }}');
  expect(workflow).toMatch(/name: Check fork ADR index\s+if: github\.event\.pull_request\.head\.repo\.full_name != github\.repository\s+run: git diff --exit-code/);
  expect(workflow).toMatch(/name: Commit ADR index\s+if: github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  expect(workflow).toContain('git push origin "HEAD:$PR_BRANCH"');
  expect(workflow).not.toContain('pull_request_target');
});
