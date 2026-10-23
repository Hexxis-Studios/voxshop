import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';
export const projects = sqliteTable('projects',{
  owner:text('owner').notNull(),id:text('id').notNull(),revision:integer('revision').notNull(),
  stateKey:text('state_key').notNull(),previousKey:text('previous_key'),summary:text('summary').notNull(),updatedAt:integer('updated_at').notNull(),
},t=>[primaryKey({columns:[t.owner,t.id]})]);
export const workspaces=sqliteTable('workspaces',{
  owner:text('owner').primaryKey(),token:text('token').notNull(),activeProject:text('active_project'),
});
export const presets=sqliteTable('presets',{
  owner:text('owner').notNull(),id:text('id').notNull(),objectKey:text('object_key').notNull(),createdAt:integer('created_at').notNull(),
},t=>[primaryKey({columns:[t.owner,t.id]})]);
