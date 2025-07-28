import { describe, expect, it } from 'bun:test';

// Test the formatting logic for the --pretty flag
describe('ji mine --pretty flag formatting', () => {
  describe('priority ordering', () => {
    it('should order priorities correctly', () => {
      const getPriorityOrder = (priority: string): number => {
        const priorityMap: Record<string, number> = {
          Highest: 1,
          High: 2,
          P1: 1,
          P2: 2,
          Medium: 3,
          P3: 3,
          Low: 4,
          P4: 4,
          Lowest: 5,
          P5: 5,
          None: 6,
          'Unassigned!': 7,
        };
        return priorityMap[priority] || 8;
      };

      // Test priority ordering
      expect(getPriorityOrder('Highest')).toBe(1);
      expect(getPriorityOrder('P1')).toBe(1);
      expect(getPriorityOrder('High')).toBe(2);
      expect(getPriorityOrder('P2')).toBe(2);
      expect(getPriorityOrder('Medium')).toBe(3);
      expect(getPriorityOrder('P3')).toBe(3);
      expect(getPriorityOrder('Low')).toBe(4);
      expect(getPriorityOrder('P4')).toBe(4);
      expect(getPriorityOrder('Lowest')).toBe(5);
      expect(getPriorityOrder('P5')).toBe(5);
      expect(getPriorityOrder('None')).toBe(6);
      expect(getPriorityOrder('Unassigned!')).toBe(7);
      expect(getPriorityOrder('Unknown')).toBe(8);
    });
  });

  describe('status color logic', () => {
    it('should identify in-progress statuses', () => {
      const isInProgress = (status: string): boolean => {
        return status.toLowerCase().includes('progress');
      };

      expect(isInProgress('In Progress')).toBe(true);
      expect(isInProgress('Work In Progress')).toBe(true);
      expect(isInProgress('Progressing')).toBe(true);
      expect(isInProgress('To Do')).toBe(false);
      expect(isInProgress('Done')).toBe(false);
    });

    it('should identify review statuses', () => {
      const isInReview = (status: string): boolean => {
        return status.toLowerCase().includes('review');
      };

      expect(isInReview('Code Review')).toBe(true);
      expect(isInReview('In Review')).toBe(true);
      expect(isInReview('Under Review')).toBe(true);
      expect(isInReview('To Do')).toBe(false);
      expect(isInReview('In Progress')).toBe(false);
    });

    it('should identify todo/open statuses', () => {
      const isTodoOrOpen = (status: string): boolean => {
        const lower = status.toLowerCase();
        return lower.includes('todo') || lower.includes('to do') || lower.includes('open');
      };

      expect(isTodoOrOpen('To Do')).toBe(true);
      expect(isTodoOrOpen('Todo')).toBe(true);
      expect(isTodoOrOpen('Open')).toBe(true);
      expect(isTodoOrOpen('Reopened')).toBe(true);
      expect(isTodoOrOpen('In Progress')).toBe(false);
      expect(isTodoOrOpen('Done')).toBe(false);
    });
  });

  describe('issue sorting', () => {
    it('should sort issues by priority then by date', () => {
      interface TestIssue {
        key: string;
        priority: string;
        updated: string | number;
      }

      const sortIssues = (issues: TestIssue[]): TestIssue[] => {
        const getPriorityOrder = (priority: string): number => {
          const priorityMap: Record<string, number> = {
            Highest: 1,
            High: 2,
            P1: 1,
            P2: 2,
            Medium: 3,
            P3: 3,
            Low: 4,
            P4: 4,
            Lowest: 5,
            P5: 5,
            None: 6,
            'Unassigned!': 7,
          };
          return priorityMap[priority] || 8;
        };

        return [...issues].sort((a, b) => {
          // First sort by priority
          const priorityDiff = getPriorityOrder(a.priority) - getPriorityOrder(b.priority);
          if (priorityDiff !== 0) return priorityDiff;

          // Then sort by updated date (most recent first)
          const aTime = typeof a.updated === 'number' ? a.updated : new Date(a.updated).getTime();
          const bTime = typeof b.updated === 'number' ? b.updated : new Date(b.updated).getTime();
          return bTime - aTime;
        });
      };

      const issues: TestIssue[] = [
        { key: 'A', priority: 'Low', updated: '2024-01-01' },
        { key: 'B', priority: 'High', updated: '2024-01-02' },
        { key: 'C', priority: 'High', updated: '2024-01-03' },
        { key: 'D', priority: 'Highest', updated: '2024-01-01' },
        { key: 'E', priority: 'Medium', updated: '2024-01-05' },
      ];

      const sorted = sortIssues(issues);
      const keys = sorted.map((i) => i.key);

      // D is Highest priority
      expect(keys[0]).toBe('D');
      // C and B are High priority, C is more recent
      expect(keys[1]).toBe('C');
      expect(keys[2]).toBe('B');
      // E is Medium priority
      expect(keys[3]).toBe('E');
      // A is Low priority
      expect(keys[4]).toBe('A');
    });
  });

  describe('YAML output format (without --pretty)', () => {
    it('should generate valid YAML structure', () => {
      interface TestIssue {
        key: string;
        project_key: string;
        summary: string;
        status: string;
        updated: string;
      }

      const generateYamlOutput = (issues: TestIssue[], projectFilter?: string) => {
        if (issues.length === 0) {
          return `projects: []\n# No open issues assigned to you${projectFilter ? ` in project ${projectFilter}` : ''}`;
        }

        const lines: string[] = ['projects:'];
        const grouped: Record<string, TestIssue[]> = {};

        // Group by project
        issues.forEach((issue) => {
          if (!grouped[issue.project_key]) {
            grouped[issue.project_key] = [];
          }
          grouped[issue.project_key].push(issue);
        });

        // Generate YAML
        Object.entries(grouped)
          .sort(([a], [b]) => a.localeCompare(b))
          .forEach(([projectKey, projectIssues]) => {
            lines.push(`  - name: ${projectKey}`);
            lines.push('    issues:');
            projectIssues.forEach((issue) => {
              lines.push(`      - key: ${issue.key}`);
              lines.push(`        title: ${issue.summary}`);
              lines.push(`        status: ${issue.status}`);
              lines.push(`        updated: ${issue.updated}`);
            });
          });

        return lines.join('\n');
      };

      // Test with issues
      const issues = [
        {
          key: 'EVAL-123',
          project_key: 'EVAL',
          summary: 'Test issue',
          status: 'Open',
          updated: '1 hour ago',
        },
      ];

      const yaml = generateYamlOutput(issues);
      expect(yaml).toContain('projects:');
      expect(yaml).toContain('- name: EVAL');
      expect(yaml).toContain('issues:');
      expect(yaml).toContain('- key: EVAL-123');
      expect(yaml).toContain('title: Test issue');
      expect(yaml).toContain('status: Open');
      expect(yaml).toContain('updated: 1 hour ago');

      // Test empty state
      const emptyYaml = generateYamlOutput([]);
      expect(emptyYaml).toBe('projects: []\n# No open issues assigned to you');

      // Test with project filter
      const filteredYaml = generateYamlOutput([], 'EVAL');
      expect(filteredYaml).toBe('projects: []\n# No open issues assigned to you in project EVAL');
    });
  });

  describe('grouping by project', () => {
    it('should group issues by project key', () => {
      interface ProjectIssue {
        key: string;
        project_key: string;
      }

      const groupIssuesByProject = (issues: ProjectIssue[]): Record<string, ProjectIssue[]> => {
        const grouped = issues.reduce(
          (acc, issue) => {
            if (!acc[issue.project_key]) {
              acc[issue.project_key] = [];
            }
            acc[issue.project_key].push(issue);
            return acc;
          },
          {} as Record<string, ProjectIssue[]>,
        );

        // Sort issues within each project
        Object.keys(grouped).forEach((key) => {
          grouped[key] = grouped[key].sort((a, b) => {
            // Sort by some criteria (e.g., key)
            return a.key.localeCompare(b.key);
          });
        });

        return grouped;
      };

      const issues = [
        { key: 'EVAL-1', project_key: 'EVAL' },
        { key: 'CFA-1', project_key: 'CFA' },
        { key: 'EVAL-2', project_key: 'EVAL' },
        { key: 'CFA-2', project_key: 'CFA' },
        { key: 'TEST-1', project_key: 'TEST' },
      ];

      const grouped = groupIssuesByProject(issues);

      expect(Object.keys(grouped)).toHaveLength(3);
      expect(grouped.EVAL).toHaveLength(2);
      expect(grouped.CFA).toHaveLength(2);
      expect(grouped.TEST).toHaveLength(1);
      expect(grouped.EVAL[0].key).toBe('EVAL-1');
      expect(grouped.EVAL[1].key).toBe('EVAL-2');
    });
  });
});
