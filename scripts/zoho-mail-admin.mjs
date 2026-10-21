#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Try loading .env if available
try {
  if (process.loadEnvFile && fs.existsSync('.env')) {
    process.loadEnvFile('.env');
  }
} catch {
  // Ignore env loading errors
}

/**
 * Parses simple CLI flags (--key value or --key)
 */
function parseArgs() {
  const rawArgs = process.argv.slice(2);
  const options = { _: [] };

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('--')) {
        options[key] = rawArgs[i + 1];
        i++;
      } else {
        options[key] = true;
      }
    } else {
      options._.push(arg);
    }
  }
  return options;
}

async function refreshAccessToken({ accountsDomain, clientId, clientSecret, refreshToken }) {
  const tokenUrl = `https://${accountsDomain}/oauth/v2/token`;
  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });

  const response = await fetch(`${tokenUrl}?${params.toString()}`, {
    method: 'POST',
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(
      `Failed to refresh Zoho OAuth token: ${data.error || response.statusText} (${JSON.stringify(data)})`
    );
  }

  return {
    accessToken: data.access_token,
    apiDomain: data.api_domain || accountsDomain.replace('accounts.', ''),
  };
}

async function getOrganizationId({ accessToken, mailHost, zoid }) {
  if (zoid) return zoid;

  console.log(`[Discover] Fetching organization ZOID from https://${mailHost}/api/organization...`);
  const orgRes = await fetch(`https://${mailHost}/api/organization`, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });

  const orgData = await orgRes.json();
  if (!orgRes.ok || (orgData.status && orgData.status.code !== 200)) {
    throw new Error(`Failed to fetch organization details: ${JSON.stringify(orgData)}`);
  }

  let effectiveZoid;
  if (Array.isArray(orgData.data) && orgData.data.length > 0) {
    effectiveZoid = orgData.data[0].zoid;
  } else if (orgData.data?.zoid) {
    effectiveZoid = orgData.data.zoid;
  } else {
    throw new Error(`Could not locate zoid in organization response: ${JSON.stringify(orgData)}`);
  }

  console.log(`✓ Organization ZOID discovered: ${effectiveZoid}`);
  return effectiveZoid;
}

async function listAccounts({ accessToken, mailHost, zoid }) {
  const accountsUrl = `https://${mailHost}/api/organization/${zoid}/accounts`;
  console.log(`[List] Fetching mail accounts from ${accountsUrl}...`);

  const res = await fetch(accountsUrl, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });

  const data = await res.json();
  if (!res.ok || (data.status && data.status.code !== 200)) {
    throw new Error(`Failed to list accounts: ${JSON.stringify(data)}`);
  }

  return data.data || [];
}

async function addEmailAlias({ accessToken, mailHost, zoid, zuid, aliasEmail }) {
  const url = `https://${mailHost}/api/organization/${zoid}/accounts/${zuid}`;
  console.log(`[Alias] Adding email alias "${aliasEmail}" to user account ZUID ${zuid}...`);

  const payload = {
    zuid: String(zuid),
    mode: 'addEmailAlias',
    emailAlias: [aliasEmail],
  };

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok || (data.status && data.status.code !== 200)) {
    throw new Error(`Failed to add email alias: ${JSON.stringify(data)}`);
  }

  return data;
}

async function changePrimaryEmail({ accessToken, mailHost, zoid, zuid, newPrimaryEmail }) {
  const url = `https://${mailHost}/api/organization/${zoid}/accounts/${zuid}`;
  console.log(`[Primary] Changing primary email address to "${newPrimaryEmail}" for ZUID ${zuid}...`);

  const payload = {
    zuid: String(zuid),
    mode: 'changePrimary',
    primaryEmailAddress: newPrimaryEmail,
  };

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok || (data.status && data.status.code !== 200)) {
    throw new Error(`Failed to change primary email: ${JSON.stringify(data)}`);
  }

  return data;
}

function printUsage() {
  console.log(`
Usage:
  node scripts/zoho-mail-admin.mjs <command> [options]

Commands:
  list                          List all user mail accounts and their aliases
  add-alias                     Add an email alias to an existing user mailbox
  set-primary                   Change the primary email address of a user
  help                          Show this help documentation

Options:
  --user <email>                Target user primary email or mailbox address
  --alias <email>               Alias email address to add (e.g. ryan.s.littleton@lsjsystems.com)
  --zuid <id>                   User ZUID / Account ID (optional, looked up from --user if omitted)
  --zoid <id>                   Zoho Organization ID (optional, auto-detected if omitted)
  --client-id <id>              Zoho OAuth Client ID (or ZOHO_CLIENT_ID env)
  --client-secret <secret>      Zoho OAuth Client Secret (or ZOHO_CLIENT_SECRET env)
  --refresh-token <token>       Zoho OAuth Refresh Token (or ZOHO_REFRESH_TOKEN env)
  --accounts-domain <domain>    Zoho Accounts Domain (default: accounts.zoho.com)
  --dry-run                     Validate parameters without calling Zoho APIs

Examples:
  # List accounts:
  node scripts/zoho-mail-admin.mjs list

  # Add ryan.s.littleton@lsjsystems.com to Ryan's mailbox:
  node scripts/zoho-mail-admin.mjs add-alias --user ryan.s.littleton@lsj.systems --alias ryan.s.littleton@lsjsystems.com

  # Set ryan.s.littleton@lsjsystems.com as primary:
  node scripts/zoho-mail-admin.mjs set-primary --user ryan.s.littleton@lsj.systems --alias ryan.s.littleton@lsjsystems.com
`);
}

async function main() {
  const args = parseArgs();
  const command = args._[0] || 'help';

  if (command === 'help' || args.help) {
    printUsage();
    process.exit(0);
  }

  const accountsDomain = args['accounts-domain'] || process.env.ZOHO_ACCOUNTS_DOMAIN || 'accounts.zoho.com';
  const domainTLD = accountsDomain.replace(/^accounts\.zoho\./, '');
  const mailHost = `mail.zoho.${domainTLD}`;

  const clientId = args['client-id'] || process.env.ZOHO_CLIENT_ID;
  const clientSecret = args['client-secret'] || process.env.ZOHO_CLIENT_SECRET;
  const refreshToken = args['refresh-token'] || process.env.ZOHO_REFRESH_TOKEN;
  let zoid = args.zoid || process.env.ZOHO_ZOID;

  if (args['dry-run']) {
    console.log('--- [Dry Run] Zoho Mail Admin ---');
    console.log(`Command       : ${command}`);
    console.log(`Mail Host     : ${mailHost}`);
    console.log(`Client ID     : ${clientId ? 'SET' : 'MISSING'}`);
    console.log(`Client Secret : ${clientSecret ? 'SET' : 'MISSING'}`);
    console.log(`Refresh Token : ${refreshToken ? 'SET' : 'MISSING'}`);
    console.log(`Target User   : ${args.user || 'None'}`);
    console.log(`Target Alias  : ${args.alias || 'None'}`);
    return;
  }

  if (!clientId || !clientSecret || !refreshToken) {
    console.error(`
[ERROR] Missing Zoho OAuth Credentials.
To interact with the Zoho Mail API, the following credentials are required:
  - ZOHO_CLIENT_ID
  - ZOHO_CLIENT_SECRET
  - ZOHO_REFRESH_TOKEN

You can set them in a local .env file or pass them as CLI options:
  --client-id <id> --client-secret <secret> --refresh-token <token>

Required OAuth Scopes:
  - ZohoMail.organization.accounts.READ
  - ZohoMail.organization.accounts.UPDATE
  - ZohoMail.organization.accounts.CREATE
`);
    process.exit(1);
  }

  console.log('Authenticating with Zoho Accounts OAuth...');
  const { accessToken } = await refreshAccessToken({
    accountsDomain,
    clientId,
    clientSecret,
    refreshToken,
  });
  console.log('✓ Access token obtained.');

  zoid = await getOrganizationId({ accessToken, mailHost, zoid });

  if (command === 'list') {
    const accounts = await listAccounts({ accessToken, mailHost, zoid });
    console.log(`\nFound ${accounts.length} account(s) in organization:`);
    for (const acc of accounts) {
      const zuid = acc.zuid || acc.accountId;
      const primary = acc.primaryEmailAddress || acc.mailboxAddress;
      const name = acc.accountDisplayName || acc.displayName || 'N/A';
      const aliases = acc.emailAliases || acc.emailAlias || [];
      console.log(`- ZUID: ${zuid} | Name: ${name} | Primary: ${primary}`);
      if (aliases.length > 0) {
        console.log(`  Aliases: ${aliases.join(', ')}`);
      }
    }
    return;
  }

  if (command === 'add-alias' || command === 'set-primary') {
    const userEmail = args.user || 'ryan.s.littleton@lsj.systems';
    const aliasEmail = args.alias || 'ryan.s.littleton@lsjsystems.com';

    let zuid = args.zuid;
    if (!zuid) {
      console.log(`Looking up user account for "${userEmail}"...`);
      const accounts = await listAccounts({ accessToken, mailHost, zoid });
      const target = accounts.find((a) => {
        const primary = (a.primaryEmailAddress || a.mailboxAddress || '').toLowerCase();
        return primary === userEmail.toLowerCase();
      });

      if (!target) {
        throw new Error(
          `User "${userEmail}" not found in organization. Use "list" command to see all accounts.`
        );
      }

      zuid = target.zuid || target.accountId;
      console.log(`✓ Found user "${target.accountDisplayName || userEmail}" (ZUID: ${zuid})`);
    }

    if (command === 'add-alias') {
      const res = await addEmailAlias({
        accessToken,
        mailHost,
        zoid,
        zuid,
        aliasEmail,
      });
      console.log(`\n🎉 Successfully added alias "${aliasEmail}" to user "${userEmail}"!`);
      console.log('Emails sent to both addresses will now be delivered to the inbox.');
    } else if (command === 'set-primary') {
      // First ensure alias exists or add it
      try {
        await addEmailAlias({ accessToken, mailHost, zoid, zuid, aliasEmail });
      } catch (e) {
        // Alias might already exist, continue to change primary
      }
      const res = await changePrimaryEmail({
        accessToken,
        mailHost,
        zoid,
        zuid,
        newPrimaryEmail: aliasEmail,
      });
      console.log(`\n🎉 Successfully updated primary email to "${aliasEmail}"!`);
    }
    return;
  }

  console.error(`Unknown command: "${command}". Run with --help for instructions.`);
  process.exit(1);
}

main().catch((err) => {
  console.error('\n[Error]', err.message || err);
  process.exit(1);
});
