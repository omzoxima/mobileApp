#!/usr/bin/env node

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logHeader(message) {
  log(`\n${'='.repeat(60)}`, 'cyan');
  log(`  ${message}`, 'bright');
  log(`${'='.repeat(60)}`, 'cyan');
}

function logSection(message) {
  log(`\n${'-'.repeat(40)}`, 'yellow');
  log(`  ${message}`, 'yellow');
  log(`${'-'.repeat(40)}`, 'yellow');
}

// Function to fetch real IDs from the database for more realistic testing
async function fetchRealIds() {
  try {
    console.log('🔍 Fetching real IDs from database for realistic load testing...');
    
    // Fetch real series IDs
    const seriesResponse = await fetch('https://tuktukiapp-dev-219733694412.asia-south1.run.app/api/series?page=1&limit=50');
    const seriesData = await seriesResponse.json();
    const seriesIds = seriesData.data?.map(series => series.id) || [];
    
    // Fetch real episode bundle IDs
    const bundleResponse = await fetch('https://tuktukiapp-dev-219733694412.asia-south1.run.app/api/episode-bundles?platform=android');
    const bundleData = await bundleResponse.json();
    const bundleIds = bundleData.data?.map(bundle => bundle.id) || [];
    
    // Fetch real episode IDs (from first few series)
    let episodeIds = [];
    if (seriesIds.length > 0) {
      const firstSeriesResponse = await fetch(`https://tuktukiapp-dev-219733694412.asia-south1.run.app/api/series/${seriesIds[0]}/episodes`);
      const episodeData = await firstSeriesResponse.json();
      episodeIds = episodeData.data?.map(episode => episode.id) || [];
    }
    
    // Fetch real user IDs (from profile creation)
    const userResponse = await fetch('https://tuktukiapp-dev-219733694412.asia-south1.run.app/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-device-id': 'load-test-fetch-ids' }
    });
    const userData = await userResponse.json();
    const userIds = userData.data?.user_id ? [userData.data.user_id] : [];
    
    console.log(`✅ Fetched real IDs: ${seriesIds.length} series, ${bundleIds.length} bundles, ${episodeIds.length} episodes, ${userIds.length} users`);
    
    return {
      seriesIds: seriesIds.length > 0 ? seriesIds : ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'],
      bundleIds: bundleIds.length > 0 ? bundleIds : ['00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000004'],
      episodeIds: episodeIds.length > 0 ? episodeIds : ['00000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000006'],
      userIds: userIds.length > 0 ? userIds : ['00000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000008']
    };
  } catch (error) {
    console.log('⚠️  Could not fetch real IDs, using fallback UUIDs:', error.message);
    return {
      seriesIds: ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'],
      bundleIds: ['00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000004'],
      episodeIds: ['00000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000006'],
      userIds: ['00000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000008']
    };
  }
}

// Function to generate persistent device IDs for load testing
function generatePersistentDeviceIds(count) {
  const deviceIds = [];
  for (let i = 0; i < count; i++) {
    deviceIds.push(`load-test-device-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 9)}`);
  }
  return deviceIds;
}

// Create Artillery configuration for 1000 users with real IDs and device ID flow
function createArtilleryConfig(realIds) {
  // Create Artillery-compatible random choice strings
  const seriesChoice = realIds.seriesIds.length > 0 ? 
    `{{ $randomChoice([${realIds.seriesIds.map(id => `"${id}"`).join(', ')}]) }}` : 
    '{{ $randomUUID() }}';
  
  const episodeChoice = realIds.episodeIds.length > 0 ? 
    `{{ $randomChoice([${realIds.episodeIds.map(id => `"${id}"`).join(', ')}]) }}` : 
    '{{ $randomUUID() }}';
  
  const bundleChoice = realIds.bundleIds.length > 0 ? 
    `{{ $randomChoice([${realIds.bundleIds.map(id => `"${id}"`).join(', ')}]) }}` : 
    '{{ $randomUUID() }}';
  
  const userChoice = realIds.userIds.length > 0 ? 
    `{{ $randomChoice([${realIds.userIds.map(id => `"${id}"`).join(', ')}]) }}` : 
    '{{ $randomUUID() }}';

  return {
    config: {
      target: 'https://tuktukiapp-dev-219733694412.asia-south1.run.app',
      phases: [
        { duration: 120, arrivalRate: 2,  name: 'Warm up - 2 users/sec for 2 minutes' },
        { duration: 300, arrivalRate: 5,  name: 'Ramp up - 5 users/sec for 5 minutes' },
        { duration: 600, arrivalRate: 10, name: 'Sustained - 10 users/sec for 10 minutes' },
        { duration: 300, arrivalRate: 15, name: 'Peak - 15 users/sec for 5 minutes' },
        { duration: 180, arrivalRate: 0,  name: 'Cool down - 0 users/sec for 3 minutes' }
      ],
      default: {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Tuktuki-LoadTest-1000/1.0'
        }
      }
    },
    scenarios: [
      {
        name: 'Guest User - Browse (No Device ID Required)',
        weight: 20,
        flow: [
          { get: { url: '/api/series', qs: { page: '{{ $randomNumber(1, 10) }}', limit: '{{ $randomNumber(5, 20) }}', category: '{{ $randomNumber(1, 5) }}' } } },
          { think: 2 },
          { get: { url: '/api/episode-bundles', qs: { platform: '{{ $randomChoice(["android", "ios"]) }}' } } },
          { think: 1 },
          { get: { url: '/api/static/about-us' } },
          { think: 1 },
          { get: { url: '/api/static/privacy-policy' } },
          { think: 3 },
          { get: { url: '/api/search', qs: { q: '{{ $randomChoice(["drama", "action", "comedy", "thriller", "romance"]) }}' } } },
          { think: 3 }
        ]
      },
      {
        name: 'User Profile Creation & Usage',
        weight: 25,
        flow: [
          // First create profile with persistent device ID
          { post: { url: '/api/profile', headers: { 'x-device-id': '{{ $randomString() }}' } } },
          { think: 2 },
          // Then use the same device ID for profile retrieval
          { get: { url: '/api/profile', headers: { 'x-device-id': '{{ $randomString() }}' } } },
          { think: 2 }
        ]
      },
      {
        name: 'Episode Access & Streaming with Device ID',
        weight: 25,
        flow: [
          // First create profile to get device ID
          { post: { url: '/api/profile', headers: { 'x-device-id': '{{ $randomString() }}' } } },
          { think: 1 },
          // Use series with real page numbers
          { get: { url: '/api/series', qs: { page: '{{ $randomNumber(1, 5) }}', limit: '{{ $randomNumber(10, 15) }}' } } },
          { think: 1 },
          // Get episodes for a series (using real series ID)
          { get: { url: `/api/series/${seriesChoice}/episodes`, headers: { 'x-device-id': '{{ $randomString() }}' } } },
          { think: 2 },
          // Get episode details (using real episode ID)
          { get: { url: `/api/episodes/${episodeChoice}`, headers: { 'x-device-id': '{{ $randomString() }}' } } },
          { think: 3 },
          // Request episode access with real IDs
          { post: { url: '/api/episode/access', json: { series_id: seriesChoice, episode_id: episodeChoice, device_id: '{{ $randomString() }}' } } },
          { think: 2 }
        ]
      },
      {
        name: 'User Actions with Device ID',
        weight: 20,
        flow: [
          // First create profile to get device ID
          { post: { url: '/api/profile', headers: { 'x-device-id': '{{ $randomString() }}' } } },
          { think: 1 },
          // Browse series first
          { get: { url: '/api/series', qs: { page: '{{ $randomNumber(1, 3) }}', limit: '{{ $randomNumber(5, 10) }}' } } },
          { think: 1 },
          // Perform actions with real IDs
          { post: { url: '/api/action', json: { action: '{{ $randomChoice(["like", "share", "subscribe"]) }}', series_id: seriesChoice, episode_id: episodeChoice }, headers: { 'x-device-id': '{{ $randomString() }}' } } },
          { think: 2 },
          { post: { url: '/api/action', json: { action: '{{ $randomChoice(["like", "share", "subscribe"]) }}', series_id: seriesChoice }, headers: { 'x-device-id': '{{ $randomString() }}' } } },
          { think: 3 }
        ]
      },
      {
        name: 'Wishlist with Device ID',
        weight: 15,
        flow: [
          // First create profile to get device ID
          { post: { url: '/api/profile', headers: { 'x-device-id': '{{ $randomString() }}' } } },
          { think: 1 },
          // Get wishlist with real user ID
          { get: { url: '/api/wishlist/series-episodes', qs: { user_id: userChoice } } },
          { think: 2 }
        ]
      },
      {
        name: 'Rewards & Transactions with Device ID',
        weight: 20,
        flow: [
          // First create profile to get device ID
          { post: { url: '/api/profile', headers: { 'x-device-id': '{{ $randomString() }}' } } },
          { think: 1 },
          // Get reward tasks
          { get: { url: '/api/task/reward_task', headers: { 'x-device-id': '{{ $randomString() }}' } } },
          { think: 2 },
          // Get user transactions
          { get: { url: '/api/task/user-transaction', headers: { 'x-device-id': '{{ $randomString() }}' } } },
          { think: 2 }
        ]
      },
      {
        name: 'Streak & Watch with Device ID',
        weight: 20,
        flow: [
          // First create profile to get device ID
          { post: { url: '/api/profile', headers: { 'x-device-id': '{{ $randomString() }}' } } },
          { think: 1 },
          // Mark episode as watched with real IDs
          { post: { url: '/api/task/streak/episode-watched', json: { user_id: userChoice, device_id: '{{ $randomString() }}', series_id: seriesChoice, episode_id: episodeChoice } } },
          { think: 3 }
        ]
      },
      {
        name: 'Ad Rewards with Device ID',
        weight: 15,
        flow: [
          // First create profile to get device ID
          { post: { url: '/api/profile', headers: { 'x-device-id': '{{ $randomString() }}' } } },
          { think: 1 },
          // Submit ad reward with real IDs
          { post: { url: '/api/task/ad-reward', json: { series_id: seriesChoice, episode_id: episodeChoice, points: '{{ $randomNumber(1, 5) }}' }, headers: { 'x-device-id': '{{ $randomString() }}' } } },
          { think: 2 }
        ]
      },
      {
        name: 'Bundle Purchase with Device ID',
        weight: 15,
        flow: [
          // First create profile to get device ID
          { post: { url: '/api/profile', headers: { 'x-device-id': '{{ $randomString() }}' } } },
          { think: 1 },
          // Purchase bundle with real IDs
          { post: { url: '/api/task/episode-bundle-purchase', json: { episode_bundle_id: bundleChoice, transaction_id: '{{ $randomString() }}', product_id: '{{ $randomString() }}', receipt: '{{ $randomString() }}', source: 'load_test_1000' }, headers: { 'x-device-id': '{{ $randomString() }}' } } },
          { think: 3 }
        ]
      },
      {
        name: 'Referral with Device ID',
        weight: 15,
        flow: [
          // First create profile to get device ID
          { post: { url: '/api/profile', headers: { 'x-device-id': '{{ $randomString() }}' } } },
          { think: 1 },
          // Submit referral with real code
          { post: { url: '/api/referral', json: { referral_code: '{{ $randomString() }}' }, headers: { 'x-device-id': '{{ $randomString() }}' } } },
          { think: 2 }
        ]
      },
      {
        name: 'SMS OTP (No Device ID Required)',
        weight: 20,
        flow: [
          { post: { url: '/api/sms/send-otp', json: { mobile: '{{ $randomNumber(6000000000, 9999999999) }}' } } },
          { think: 3 },
          { post: { url: '/api/sms/verify-otp', json: { mobile: '{{ $randomNumber(6000000000, 9999999999) }}', otp: '{{ $randomNumber(100000, 999999) }}' } } },
          { think: 3 }
        ]
      },
      {
        name: 'Social Login (No Device ID Required)',
        weight: 15,
        flow: [
          { post: { url: '/api/auth/social-login', json: { provider: '{{ $randomChoice(["google", "facebook", "apple"]) }}', token: '{{ $randomString() }}', deviceId: '{{ $randomString() }}' } } },
          { think: 2 }
        ]
      },
      {
        name: 'Token Verify (No Device ID Required)',
        weight: 10,
        flow: [
          { post: { url: '/api/auth/verify-token', json: { token: '{{ $randomString() }}' } } },
          { think: 1 }
        ]
      },
      {
        name: 'CDN Signed Cookie (No Device ID Required)',
        weight: 10,
        flow: [
          { post: { url: '/api/signedcookie', json: { url_prefix: 'https://cdn.tuktuki.com/hls_output/{{ $randomUUID() }}/' } } },
          { think: 1 }
        ]
      },
      {
        name: 'Cache Management (No Device ID Required)',
        weight: 5,
        flow: [
          { post: { url: '/api/cache/invalidate', json: { type: '{{ $randomChoice(["series", "wishlist", "bundles", "episodes", "user_session"]) }}', userId: userChoice, seriesId: seriesChoice, deviceId: '{{ $randomString() }}' } } },
          { think: 1 },
          { get: { url: '/api/cache/health' } },
          { think: 1 }
        ]
      }
    ]
  };
}

async function runLoadTest() {
  try {
    logHeader('🚀 STARTING LOAD TEST FOR 1000 USERS');
    const realIds = await fetchRealIds();
    const config = createArtilleryConfig(realIds);

    // Write a temp config in the project root
    const tempConfigPath = path.join(__dirname, 'artillery-config.yml');

    const yaml = `# Artillery Load Test Configuration for 1000 Users\n` +
`# Generated: ${new Date().toISOString()}\n` +
`# Target: ${config.config.target}\n` +
`config:\n  target: '${config.config.target}'\n  phases:\n` +
config.config.phases.map(p => `    - duration: ${p.duration}\n      arrivalRate: ${p.arrivalRate}\n      name: '${p.name}'\n`).join('') +
`  default:\n    headers:\n      'Content-Type': 'application/json'\n      'User-Agent': 'Tuktuki-LoadTest-1000/1.0'\n\nscenarios:\n` +
config.scenarios.map(s => {
  let sYaml = `  - name: '${s.name}'\n    weight: ${s.weight}\n    flow:\n`;
  s.flow.forEach(step => {
    if (step.get) {
      sYaml += `      - get:\n          url: '${step.get.url}'\n`;
      if (step.get.qs) sYaml += `          qs: ${JSON.stringify(step.get.qs)}\n`;
      if (step.get.headers) sYaml += `          headers: ${JSON.stringify(step.get.headers)}\n`;
    } else if (step.post) {
      sYaml += `      - post:\n          url: '${step.post.url}'\n`;
      if (step.post.json) sYaml += `          json: ${JSON.stringify(step.post.json)}\n`;
      if (step.post.headers) sYaml += `          headers: ${JSON.stringify(step.post.headers)}\n`;
    } else if (typeof step.think !== 'undefined') {
      sYaml += `      - think: ${step.think}\n`;
    }
  });
  return sYaml + '\n';
}).join('');

    fs.writeFileSync(tempConfigPath, yaml);

    // Single final report file (JSON) in project root
    const finalReportPath = path.join(__dirname, 'load-test-final-report.json');

    logSection('Starting Load Test');
    const cmd = `npx artillery run --output ${finalReportPath} ${tempConfigPath}`;
    log(`Command: ${cmd}`, 'cyan');
    execSync(cmd, { stdio: 'inherit', cwd: __dirname });

    logHeader('🎉 LOAD TEST COMPLETED');
    log(`Final report saved to: ${finalReportPath}`, 'green');

    // Clean up temp config
    try { fs.unlinkSync(tempConfigPath); } catch {}

    return { success: true, finalReportPath };
  } catch (error) {
    log(`❌ Load test failed: ${error.message}`, 'red');
    return { success: false, error: error.message };
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    logHeader('Load Testing Script for 1000 Users');
    log(`Usage: node load-test-1000-users.js`, 'yellow');
    log(`Outputs a single file: load-test-final-report.json`, 'yellow');
    return;
  }

  try {
    execSync('npx artillery --version', { stdio: 'ignore' });
  } catch {
    log('Artillery not found. Installing...', 'yellow');
    execSync('npm install --save-dev artillery', { stdio: 'inherit', cwd: __dirname });
  }

  const result = await runLoadTest();
  if (!result.success) process.exit(1);
}

main().catch(err => {
  log(`❌ Script execution failed: ${err.message}`, 'red');
  process.exit(1);
});
