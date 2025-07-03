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

// Categorize fields for better display
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
    .slice(0, 10);

  return { acceptanceCriteria, storyPoints, otherUseful };
};

// Main field discovery Effect
const discoverCustomFieldsEffect = () =>
  pipe(
    getConfigEffect(),
    Effect.flatMap(({ config, configManager }) => {
      const jiraClient = new JiraClient(config);

      return pipe(
        Effect.sync(() => {
          console.log(chalk.bold('\n🔍 Custom Field Discovery\n'));
          console.log(chalk.cyan('Discovering custom fields from your Jira instance...'));
        }),
        Effect.flatMap(() => getCustomFieldsEffect(jiraClient)),
        Effect.flatMap((customFields) =>
          Effect.sync(() => {
            const categories = categorizeFields(customFields);

            console.log(chalk.yellow('\n✅ Good News!'));
            console.log(chalk.white('All custom fields are automatically fetched and displayed in issue views.'));
            console.log(chalk.white('No configuration needed!'));

            if (categories.acceptanceCriteria.length > 0) {
              console.log(chalk.yellow('\n📋 Acceptance Criteria Fields Found:'));
              categories.acceptanceCriteria.forEach((field, index) => {
                console.log(`  ${index + 1}. ${chalk.white(field.name)} (${chalk.green(field.id)})`);
                if (field.description) {
                  console.log(`     ${chalk.dim(field.description)}`);
                }
              });
            }

            if (categories.storyPoints.length > 0) {
              console.log(chalk.yellow('\n📊 Story Points Fields Found:'));
              categories.storyPoints.forEach((field, index) => {
                console.log(`  ${index + 1}. ${chalk.white(field.name)} (${chalk.green(field.id)})`);
              });
            }

            if (categories.otherUseful.length > 0) {
              console.log(chalk.yellow('\n🔧 Other Useful Fields Found:'));
              categories.otherUseful.forEach((field, index) => {
                console.log(`  ${index + 1}. ${chalk.white(field.name)} (${chalk.green(field.id)})`);
              });
            }

            console.log(chalk.yellow('\n🚀 Next Steps:'));
            console.log(chalk.white('1. Run: ji sync --clean  (to fetch all custom fields)'));
            console.log(chalk.white('2. Test: ji PROJ-123     (all custom fields will appear)'));

            console.log(chalk.yellow(`\n📄 Summary: ${customFields.length} total custom fields available`));
            console.log(chalk.dim('  All fields are automatically included in issue views'));
          }),
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
    await Effect.runPromise(discoverCustomFieldsEffect());
  } catch (_error) {
    process.exit(1);
  }
}
