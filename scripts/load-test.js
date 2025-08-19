#!/usr/bin/env node

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Colors for console output
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

function runCommand(command, description) {
  try {
    log(`\n🔄 ${description}...`, 'blue');
    log(`Command: ${command}`, 'cyan');
    
    const result = execSync(command, { 
      encoding: 'utf8', 
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..')
    });
    
    log(`✅ ${description} completed successfully`, 'green');
    return result;
  } catch (error) {
    log(`❌ ${description} failed: ${error.message}`, 'red');
    throw error;
  }
}

function createReportDirectory() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = path.join(__dirname, '..', 'load-test-reports', timestamp);
  
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }
  
  return reportDir;
}

function updateConfigWithEnvironment(environment) {
  const configPath = path.join(__dirname, '..', 'load-test-config.yml');
  const envConfigPath = path.join(__dirname, '..', 'load-test-environments.yml');
  
  if (!fs.existsSync(configPath)) {
    throw new Error('load-test-config.yml not found');
  }
  
  if (!fs.existsSync(envConfigPath)) {
    throw new Error('load-test-environments.yml not found');
  }
  
  // Read the main config
  let config = fs.readFileSync(configPath, 'utf8');
  
  // Update target URL based on environment
  const envConfig = fs.readFileSync(envConfigPath, 'utf8');
  const envMatch = envConfig.match(new RegExp(`${environment}:\\s*\\n\\s*target:\\s*['"]([^'"]+)['"]`));
  
  if (envMatch) {
    const targetUrl = envMatch[1];
    config = config.replace(/target:\s*['"][^'"]+['"]/, `target: '${targetUrl}'`);
    log(`🎯 Updated target URL to: ${targetUrl}`, 'green');
  }
  
  return config;
}

async function runLoadTest(environment, testType = 'comprehensive') {
  try {
    logHeader(`🚀 Starting Load Test - Environment: ${environment.toUpperCase()}`);
    
    // Create report directory
    const reportDir = createReportDirectory();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // Update config with environment-specific settings
    const updatedConfig = updateConfigWithEnvironment(environment);
    const tempConfigPath = path.join(reportDir, 'temp-config.yml');
    fs.writeFileSync(tempConfigPath, updatedConfig);
    
    // Determine test configuration based on type
    let testConfig = '';
    let outputFile = '';
    
    switch (testType) {
      case 'smoke':
        testConfig = `-e ${environment} --overrides '{"phases":[{"duration":30,"arrivalRate":1}]}'`;
        outputFile = path.join(reportDir, 'smoke-test-results.json');
        break;
      case 'stress':
        testConfig = `-e stress-test --overrides '{"phases":[{"duration":60,"arrivalRate":200},{"duration":120,"arrivalRate":300}]}'`;
        outputFile = path.join(reportDir, 'stress-test-results.json');
        break;
      case 'spike':
        testConfig = `-e spike-test`;
        outputFile = path.join(reportDir, 'spike-test-results.json');
        break;
      default:
        testConfig = `-e ${environment}`;
        outputFile = path.join(reportDir, 'comprehensive-test-results.json');
    }
    
    // Run the load test
    const command = `npx artillery run ${testConfig} --output ${outputFile} ${tempConfigPath}`;
    runCommand(command, `Running ${testType} load test on ${environment}`);
    
    // Generate HTML report
    if (fs.existsSync(outputFile)) {
      logSection('Generating HTML Report');
      const htmlReportPath = path.join(reportDir, 'load-test-report.html');
      runCommand(`npx artillery report --output ${htmlReportPath} ${outputFile}`, 'Generating HTML report');
      
      log(`📊 Load test completed!`, 'green');
      log(`📁 Results saved to: ${reportDir}`, 'cyan');
      log(`📄 JSON results: ${outputFile}`, 'cyan');
      log(`🌐 HTML report: ${htmlReportPath}`, 'cyan');
      
      // Clean up temp config
      fs.unlinkSync(tempConfigPath);
      
      return { success: true, reportDir, outputFile, htmlReportPath };
    } else {
      throw new Error('Load test output file not found');
    }
    
  } catch (error) {
    log(`❌ Load test failed: ${error.message}`, 'red');
    return { success: false, error: error.message };
  }
}

function showUsage() {
  logHeader('Load Testing Script Usage');
  log(`
Available commands:
  node scripts/load-test.js <environment> [test-type]

Environments:
  local       - Test against localhost:8080
  hosted      - Test against your hosted environment

Test Types:
  smoke       - Quick functionality test (1 user, 30 seconds)
  stress      - High load stress test
  spike       - Sudden traffic spike test
  comprehensive - Full load test (default)

Examples:
  node scripts/load-test.js local
  node scripts/load-test.js hosted smoke
  node scripts/load-test.js hosted stress
  node scripts/load-test.js hosted comprehensive

Note: Make sure to update the URLs in load-test-environments.yml
before running tests against your hosted environments.
`, 'yellow');
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    showUsage();
    return;
  }
  
  const environment = args[0];
  const testType = args[1] || 'comprehensive';
  
  // Validate environment
  const validEnvironments = ['local', 'hosted'];
  if (!validEnvironments.includes(environment)) {
    log(`❌ Invalid environment: ${environment}`, 'red');
    log(`Valid environments: ${validEnvironments.join(', ')}`, 'yellow');
    return;
  }
  
  // Validate test type
  const validTestTypes = ['smoke', 'stress', 'spike', 'comprehensive'];
  if (!validTestTypes.includes(testType)) {
    log(`❌ Invalid test type: ${testType}`, 'red');
    log(`Valid test types: ${validTestTypes.join(', ')}`, 'yellow');
    return;
  }
  
  // Check if Artillery is installed
  try {
    execSync('npx artillery --version', { stdio: 'ignore' });
  } catch (error) {
    log('❌ Artillery not found. Installing...', 'red');
    runCommand('npm install --save-dev artillery', 'Installing Artillery');
  }
  
  // Run the load test
  const result = await runLoadTest(environment, testType);
  
  if (result.success) {
    logHeader('🎉 Load Test Completed Successfully!');
    log(`Environment: ${environment}`, 'green');
    log(`Test Type: ${testType}`, 'green');
    log(`Report Directory: ${result.reportDir}`, 'cyan');
  } else {
    logHeader('💥 Load Test Failed');
    log(`Error: ${result.error}`, 'red');
    process.exit(1);
  }
}

// Run the script
main().catch(error => {
  log(`❌ Script execution failed: ${error.message}`, 'red');
  process.exit(1);
});
