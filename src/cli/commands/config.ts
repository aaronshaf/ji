import chalk from 'chalk';
import { Effect, pipe, Schema } from 'effect';
import { ConfigManager } from '../../lib/config.js';
import { JiraClient } from '../../lib/jira-client.js';

// Schema for custom field
const CustomFieldSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  type: Schema.String,
});

type CustomField = Schema.Schema.Type<typeof CustomFieldSchema>;

// Get configuration Effect
const getConfigEffect = () =>
  Effect.tryPromise({
    try: async () => {
      const configManager = new ConfigManager();
      try {
        const config = await configManager.getConfig();
        if (!config) {
          throw new Error('No configuration found. Please run "ji auth" first.');
        }
        return { config, configManager };
      } catch (error) {
        configManager.close();
        throw error;
      }
    },
    catch: (error) => new Error(`Failed to get configuration: ${error}`),
  });

// Get custom fields Effect
const getCustomFieldsEffect = (jiraClient: JiraClient) =>
  Effect.tryPromise({
    try: async () => {
      const fields = await jiraClient.getCustomFields();
      return fields.map((field) => Schema.decodeUnknownSync(CustomFieldSchema)(field));
    },
    catch: (error) => new Error(`Failed to get custom fields: ${error}`),
  });

// Get current configured fields Effect
const getCurrentConfigEffect = (configManager: ConfigManager) =>
  Effect.tryPromise({
    try: async () => {
      const currentFields = await configManager.getSetting('customFields');
      return currentFields ? JSON.parse(currentFields) : {};
    },
    catch: () => ({}), // Return empty object if no config
  });

// Categorize fields
const categorizeFields = (customFields: CustomField[]) => {
  const acceptanceCriteria = customFields.filter(
    (field) =>
      field.name.toLowerCase().includes('acceptance') ||
      field.name.toLowerCase().includes('criteria') ||
      field.name.toLowerCase().includes('ac ') ||
      field.name.toLowerCase() === 'ac' ||
      field.name.toLowerCase().includes('definition of done') ||
      field.name.toLowerCase().includes('dod'),
  );

  const storyPoints = customFields.filter(
    (field) =>
      field.name.toLowerCase().includes('story point') ||
      field.name.toLowerCase().includes('points') ||
      field.name.toLowerCase().includes('estimate'),
  );

  const otherUseful = customFields
    .filter(
      (field) =>
        !acceptanceCriteria.includes(field) &&
        !storyPoints.includes(field) &&
        (field.name.toLowerCase().includes('epic') ||
          field.name.toLowerCase().includes('team') ||
          field.name.toLowerCase().includes('environment') ||
          field.name.toLowerCase().includes('version') ||
          field.name.toLowerCase().includes('release')),
    )
    .slice(0, 5);

  return { acceptanceCriteria, storyPoints, otherUseful };
};

// Main configuration Effect
const configureCustomFieldsEffect = () =>
  pipe(
    getConfigEffect(),
    Effect.flatMap(({ config, configManager }) => {
      const jiraClient = new JiraClient(config);

      return pipe(
        Effect.sync(() => {
          console.log(chalk.bold('\n⚙️  Configure Custom Fields\n'));
          console.log(chalk.cyan('Discovering custom fields from your Jira instance...'));
        }),
        Effect.flatMap(() => getCustomFieldsEffect(jiraClient)),
        Effect.flatMap((customFields) =>
          pipe(
            getCurrentConfigEffect(configManager),
            Effect.map((configuredFields) => {
              const categories = categorizeFields(customFields);

              console.log(chalk.yellow('\n📋 Recommended Custom Fields:'));

              if (categories.acceptanceCriteria.length > 0) {
                console.log(chalk.cyan('\n  Acceptance Criteria Fields:'));
                categories.acceptanceCriteria.forEach((field, index) => {
                  const isConfigured = configuredFields[field.id];
                  const status = isConfigured ? chalk.green('✓ enabled') : chalk.dim('  disabled');
                  console.log(`    ${index + 1}. ${chalk.white(field.name)} (${chalk.green(field.id)}) ${status}`);
                  if (field.description) {
                    console.log(`       ${chalk.dim(field.description)}`);
                  }
                });
              }

              if (categories.storyPoints.length > 0) {
                console.log(chalk.cyan('\n  Story Points Fields:'));
                categories.storyPoints.forEach((field, index) => {
                  const isConfigured = configuredFields[field.id];
                  const status = isConfigured ? chalk.green('✓ enabled') : chalk.dim('  disabled');
                  console.log(`    ${index + 1}. ${chalk.white(field.name)} (${chalk.green(field.id)}) ${status}`);
                });
              }

              if (categories.otherUseful.length > 0) {
                console.log(chalk.cyan('\n  Other Useful Fields:'));
                categories.otherUseful.forEach((field, index) => {
                  const isConfigured = configuredFields[field.id];
                  const status = isConfigured ? chalk.green('✓ enabled') : chalk.dim('  disabled');
                  console.log(`    ${index + 1}. ${chalk.white(field.name)} (${chalk.green(field.id)}) ${status}`);
                });
              }

              console.log(chalk.yellow('\n📝 Configuration Instructions:'));
              console.log(chalk.white('To enable custom fields, run these commands:'));
              console.log('');

              if (categories.acceptanceCriteria.length > 0) {
                const topAC = categories.acceptanceCriteria[0];
                console.log(chalk.green(`# Enable acceptance criteria field:`));
                console.log(
                  chalk.white(
                    `sqlite3 ~/.ji/data.db "INSERT OR REPLACE INTO config (key, value) VALUES ('customField_${topAC.id}', '${topAC.name}')"`,
                  ),
                );
              }

              if (categories.storyPoints.length > 0) {
                const topSP = categories.storyPoints[0];
                console.log(chalk.green(`# Enable story points field:`));
                console.log(
                  chalk.white(
                    `sqlite3 ~/.ji/data.db "INSERT OR REPLACE INTO config (key, value) VALUES ('customField_${topSP.id}', '${topSP.name}')"`,
                  ),
                );
              }

              console.log('');
              console.log(chalk.yellow('🔄 After configuring fields:'));
              console.log(chalk.white('1. Run: ji sync --clean  (to fetch new fields)'));
              console.log(chalk.white('2. Test: ji PROJ-123     (custom fields will appear in issue details)'));

              console.log(chalk.yellow('\n📊 Current Status:'));
              if (Object.keys(configuredFields).length === 0) {
                console.log(chalk.dim('  No custom fields configured yet'));
              } else {
                console.log(chalk.green(`  ${Object.keys(configuredFields).length} custom fields enabled`));
                Object.entries(configuredFields).forEach(([fieldId, fieldName]) => {
                  console.log(`    ${chalk.green(fieldId)}: ${fieldName}`);
                });
              }

              console.log(chalk.yellow(`\n📄 All Custom Fields Available (${customFields.length} total):`));
              console.log(chalk.dim('  Use the field IDs above in your configuration commands'));

              return configuredFields;
            }),
          ),
        ),
        Effect.tap(() => Effect.sync(() => configManager.close())),
        Effect.catchAll((error) =>
          pipe(
            Effect.sync(() => {
              const message = error instanceof Error ? error.message : String(error);
              console.error(chalk.red('Error:'), message);
              configManager.close();
            }),
            Effect.flatMap(() => Effect.fail(error)),
          ),
        ),
      );
    }),
  );

export async function configureCustomFields() {
  try {
    await Effect.runPromise(configureCustomFieldsEffect());
  } catch (_error) {
    process.exit(1);
  }
}
