import { Command, Args, Flags } from '@oclif/core';
import { ConfigManager } from '../../lib/config.js';
import { JiraClient } from '../../lib/jira-client.js';

export default class IssueView extends Command {
  static description = 'View a Jira issue';

  static examples = [
    '<%= config.bin %> <%= command.id %> PROJ-123',
  ];

  static args = {
    issueKey: Args.string({
      description: 'Issue key (e.g., PROJ-123)',
      required: true,
    }),
  };

  static flags = {
    json: Flags.boolean({
      char: 'j',
      description: 'Output as JSON',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IssueView);
    
    const configManager = new ConfigManager();
    const config = await configManager.getConfig();
    
    if (!config) {
      this.error('No configuration found. Please run "ji auth" first.');
    }

    try {
      const client = new JiraClient(config);
      const issue = await client.getIssue(args.issueKey);

      if (flags.json) {
        this.log(JSON.stringify(issue, null, 2));
      } else {
        this.log(`\n📋 ${issue.key}: ${issue.fields.summary}`);
        this.log(`\n🔖 Status: ${issue.fields.status.name}`);
        if (issue.fields.priority) {
          this.log(`🎯 Priority: ${issue.fields.priority.name}`);
        }
        if (issue.fields.assignee) {
          this.log(`👤 Assignee: ${issue.fields.assignee.displayName}`);
        }
        this.log(`📝 Reporter: ${issue.fields.reporter.displayName}`);
        this.log(`📅 Created: ${new Date(issue.fields.created).toLocaleString()}`);
        this.log(`🔄 Updated: ${new Date(issue.fields.updated).toLocaleString()}`);
        
        if (issue.fields.description) {
          this.log('\n📄 Description:');
          this.log(this.formatDescription(issue.fields.description));
        }
      }
    } catch (error) {
      this.error(`Failed to fetch issue: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      configManager.close();
    }
  }

  private formatDescription(description: any): string {
    if (typeof description === 'string') {
      return description;
    }
    
    // Handle Atlassian Document Format (ADF)
    if (description?.content) {
      return this.parseADF(description);
    }
    
    return 'No description available';
  }

  private parseADF(doc: any): string {
    let text = '';
    
    const parseNode = (node: any): string => {
      if (node.type === 'text') {
        return node.text || '';
      }
      
      if (node.content) {
        return node.content.map((n: any) => parseNode(n)).join('');
      }
      
      if (node.type === 'paragraph') {
        return '\n' + (node.content?.map((n: any) => parseNode(n)).join('') || '') + '\n';
      }
      
      return '';
    };
    
    if (doc.content) {
      text = doc.content.map((node: any) => parseNode(node)).join('');
    }
    
    return text.trim();
  }
}