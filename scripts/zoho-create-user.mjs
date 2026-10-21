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
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        options[key] = args[i + 1];
        i++;
      } else {
        options[key] = true;
      }
    }
  }
  return options;
}

function generateSecurePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*()_+-=';
  const all = upper + lower + digits + symbols;

  const pick = (charset) => charset[crypto.randomInt(0, charset.length)];

  const base = [
    pick(upper),
    pick(lower),
    pick(digits),
    pick(symbols),
  ];

  for (let i = 0; i < 12; i++) {
    base.push(pick(all));
  }

  // Shuffle
  return base.sort(() => crypto.randomInt(-1, 2)).join('');
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

async function createZohoMailUser({
  accessToken,
  domainTLD,
  zoid,
  email,
  firstName,
  lastName,
  displayName,
  password,
  phone,
}) {
  const mailHost = `mail.zoho.${domainTLD}`;

  // 1. Fetch ZOID if not specified
  let effectiveZoid = zoid;
  if (!effectiveZoid) {
    console.log(`[1/2] Fetching organization ZOID from https://${mailHost}/api/organization...`);
    const orgRes = await fetch(`https://${mailHost}/api/organization`, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
      },
    });

    const orgData = await orgRes.json();
    if (!orgRes.ok || (orgData.status && orgData.status.code !== 200)) {
      throw new Error(`Failed to fetch organization details: ${JSON.stringify(orgData)}`);
    }

    if (Array.isArray(orgData.data) && orgData.data.length > 0) {
      effectiveZoid = orgData.data[0].zoid;
    } else if (orgData.data?.zoid) {
      effectiveZoid = orgData.data.zoid;
    } else {
      throw new Error(`Could not locate zoid in organization response: ${JSON.stringify(orgData)}`);
    }

    console.log(`✓ Organization ZOID discovered: ${effectiveZoid}`);
  }

  // 2. Create the user account
  const createUrl = `https://${mailHost}/api/organization/${effectiveZoid}/accounts`;
  console.log(`[2/2] Creating user account for ${email} at ${createUrl}...`);

  const payload = {
    primaryEmailAddress: email,
    password: password,
    firstName: firstName,
    lastName: lastName,
    displayName: displayName || `${firstName} ${lastName}`.trim(),
    role: 'member',
    oneTimePassword: true,
  };
  if (phone) {
    payload.phoneNumber = phone;
  }

  const createRes = await fetch(createUrl, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const createData = await createRes.json();
  if (!createRes.ok || (createData.status && createData.status.code !== 200)) {
    throw new Error(`Failed to create Zoho Mail user: ${JSON.stringify(createData)}`);
  }

  return {
    provider: 'Zoho Mail / Workplace',
    email,
    zoid: effectiveZoid,
    response: createData,
  };
}

async function createZohoCrmUser({
  accessToken,
  domainTLD,
  email,
  firstName,
  lastName,
  phone,
  roleId,
  profileId,
}) {
  const crmHost = `www.zohoapis.${domainTLD}`;
  const crmUrl = `https://${crmHost}/crm/v8/users`;

  console.log(`Creating Zoho CRM user for ${email} at ${crmUrl}...`);
  if (!roleId || !profileId) {
    throw new Error(
      'Creating a Zoho CRM user requires --role-id and --profile-id (or ZOHO_CRM_ROLE_ID and ZOHO_CRM_PROFILE_ID env vars).'
    );
  }

  const userRecord = {
    first_name: firstName,
    last_name: lastName,
    email: email,
    role: roleId,
    profile: profileId,
  };
  if (phone) {
    userRecord.phone = phone;
  }

  const payload = {
    users: [userRecord],
  };

  const res = await fetch(crmUrl, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Failed to create Zoho CRM user: ${JSON.stringify(data)}`);
  }

  return {
    provider: 'Zoho CRM',
    email,
    response: data,
  };
}

async function main() {
  const args = parseArgs();

  if (args.help || args.h) {
    console.log(`
Usage:
  node scripts/zoho-create-user.mjs [options]

Options:
  --email <email>            Primary user email (default: ryan.s.littleton@lsjsystems.com)
  --first-name <name>        First name (default: Ryan)
  --last-name <name>         Last name (default: Littleton)
  --phone <phone>            Phone number (default: 202-913-5204)
  --display-name <name>      Display name (default: Ryan Littleton)
  --password <password>      Initial temporary password (auto-generated if omitted)
  --service <mail|crm>       Zoho service target (default: mail)
  --zoid <zoid>              Zoho Organization ID for Mail (auto-fetched if omitted)
  --role-id <id>             CRM Role ID (required for CRM service)
  --profile-id <id>          CRM Profile ID (required for CRM service)
  --client-id <id>           Zoho OAuth Client ID (or ZOHO_CLIENT_ID env)
  --client-secret <secret>   Zoho OAuth Client Secret (or ZOHO_CLIENT_SECRET env)
  --refresh-token <token>    Zoho OAuth Refresh Token (or ZOHO_REFRESH_TOKEN env)
  --accounts-domain <domain> Zoho Accounts domain (default: accounts.zoho.com)
  --dry-run                  Validate configuration without calling Zoho APIs
`);
    process.exit(0);
  }

  const email = args.email || process.env.USER_EMAIL || process.env.NEW_USER_EMAIL || 'ryan.s.littleton@lsjsystems.com';
  const firstName = args['first-name'] || process.env.USER_FIRST_NAME || process.env.NEW_USER_FIRST_NAME || 'Ryan';
  const lastName = args['last-name'] || process.env.USER_LAST_NAME || process.env.NEW_USER_LAST_NAME || 'Littleton';
  const phone = args.phone || process.env.USER_PHONE || process.env.NEW_USER_PHONE || '202-913-5204';
  const displayName = args['display-name'] || `${firstName} ${lastName}`.trim();
  const password = args.password || process.env.NEW_USER_PASSWORD || generateSecurePassword();

  const service = (args.service || process.env.ZOHO_SERVICE || 'mail').toLowerCase();
  const accountsDomain = args['accounts-domain'] || process.env.ZOHO_ACCOUNTS_DOMAIN || 'accounts.zoho.com';
  const domainTLD = accountsDomain.replace(/^accounts\.zoho\./, '');

  const clientId = args['client-id'] || process.env.ZOHO_CLIENT_ID;
  const clientSecret = args['client-secret'] || process.env.ZOHO_CLIENT_SECRET;
  const refreshToken = args['refresh-token'] || process.env.ZOHO_REFRESH_TOKEN;
  const zoid = args.zoid || process.env.ZOHO_ZOID;

  console.log('--- Zoho User Provisioning ---');
  console.log(`Target Service : ${service.toUpperCase()}`);
  console.log(`User Email     : ${email}`);
  console.log(`First / Last   : ${firstName} ${lastName}`);
  console.log(`Phone          : ${phone}`);
  console.log(`Accounts Domain: ${accountsDomain}`);
  console.log(`Domain Region  : .${domainTLD}`);

  if (args['dry-run']) {
    console.log('\n[Dry Run] Validating parameters only:');
    console.log(`Client ID configured     : ${clientId ? 'YES' : 'NO'}`);
    console.log(`Client Secret configured : ${clientSecret ? 'YES' : 'NO'}`);
    console.log(`Refresh Token configured : ${refreshToken ? 'YES' : 'NO'}`);
    console.log(`Generated Password       : ${password ? 'YES (masked)' : 'NO'}`);
    console.log('\nDry run completed successfully.');
    return;
  }

  if (!clientId || !clientSecret || !refreshToken) {
    console.error(`
[ERROR] Missing Zoho OAuth Credentials.
The following credentials must be set in your environment or in a .env file:
  - ZOHO_CLIENT_ID
  - ZOHO_CLIENT_SECRET
  - ZOHO_REFRESH_TOKEN

How to generate them:
1. Go to Zoho API Console: https://api-console.zoho.com/
2. Create a "Server-based Application" or "Self Client".
3. For Zoho Mail/Workplace, request scope:
     ZohoMail.organization.accounts.CREATE,ZohoMail.organization.accounts.READ
   For Zoho CRM, request scope:
     ZohoCRM.users.CREATE,ZohoCRM.users.READ
4. Generate a Refresh Token and configure them in .env or GitHub Secrets.
`);
    process.exit(1);
  }

  console.log('\nAuthenticating with Zoho OAuth...');
  const { accessToken } = await refreshAccessToken({
    accountsDomain,
    clientId,
    clientSecret,
    refreshToken,
  });
  console.log('✓ Successfully retrieved access token.');

  let result;
  if (service === 'mail') {
    result = await createZohoMailUser({
      accessToken,
      domainTLD,
      zoid,
      email,
      firstName,
      lastName,
      displayName,
      password,
      phone,
    });
  } else if (service === 'crm') {
    result = await createZohoCrmUser({
      accessToken,
      domainTLD,
      email,
      firstName,
      lastName,
      phone,
      roleId: args['role-id'] || process.env.ZOHO_CRM_ROLE_ID,
      profileId: args['profile-id'] || process.env.ZOHO_CRM_PROFILE_ID,
    });
  } else {
    throw new Error(`Unsupported service "${service}". Use "mail" or "crm".`);
  }

  console.log('\n🎉 User created successfully!');
  console.log(`Service  : ${result.provider}`);
  console.log(`Email    : ${result.email}`);
  if (service === 'mail') {
    console.log(`Password : ${password}`);
    console.log('Notice   : oneTimePassword is set to true. The user will be prompted to reset password upon first login.');
  }
}

main().catch((err) => {
  console.error('\n[Execution Error]', err.message || err);
  process.exit(1);
});
