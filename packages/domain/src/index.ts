export * from './commands.js';
export * from './config.js';
export * from './content-validation.js';
export * from './prompt-preparation.js';
export * from './schemas.js';
export * from './validation.js';

export const domainPackageName = '@news-writer/domain' as const;

export const getDomainPackageName = (): typeof domainPackageName => domainPackageName;
