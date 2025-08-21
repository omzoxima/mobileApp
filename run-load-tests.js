#!/usr/bin/env node

import { spawn } from 'child_process';
import { performance } from 'perf_hooks';
import fs from 'fs';
import path from 'path';

// Configuration
const CONFIG = {
  BASE_URL: process.env.BASE_URL || 'https://tuktukiapp-dev-219733694412.asia-south1.run.app',
  TEST_TYPES: {
    CUSTOM: 'custom',
    ARTILLERY: 'artillery',
    BOTH: 'both'
  },
  OUTPUT_DIR: './load-test-results',
  REPORTS: {
    CUSTOM: 'custom-load-test-report.json',
    ARTILLERY: 'artillery-report.json',
    SUMMARY: 'load-test-summary.md'
  }
};

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

class LoadTestRunner {
  constructor() {
    this.startTime = null;
    this.endTime = null;
    this.results = {
      custom: null,
      artillery: null,
      summary: null
    };
  }

  log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
  }

  logHeader(message) {
    this.log(`\n${'='.repeat(60)}`, 'cyan');
    this.log(`  ${message}`, 'bright');
    this.log(`${'='.repeat(60)}`, 'cyan');
  }

  logSection(message) {
    this.log(`\n${'-'.repeat(40)}`, 'yellow');
    this.log(`  ${message}`, 'yellow');
    this.log(`${'-'.repeat(40)}`, 'yellow');
  }

  async checkPrerequisites() {
    this.logSection('Checking Prerequisites');
    
    // Check if Node.js is available
    try {
      const nodeVersion = process.version;
      this.log(`✅ Node.js version: ${nodeVersion}`, 'green');
    } catch (error) {
      this.log('❌ Node.js not available', 'red');
      return false;
    }

    // Check if npm packages are installed
    try {
      const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      const hasArtillery = packageJson.devDependencies?.artillery;
      
      if (hasArtillery) {
        this.log('✅ Artillery is installed', 'green');
      } else {
        this.log('⚠️  Artillery not found in devDependencies', 'yellow');
        this.log('💡 Run: npm install --save-dev artillery', 'blue');
      }
    } catch (error) {
      this.log('❌ Cannot read package.json', 'red');
      return false;
    }

    // Check if server is running
    try {
      const { default: axios } = await import('axios');
      const response = await axios.get(`${CONFIG.BASE_URL}/api/health`, { timeout: 5000 });
      if (response.status === 200) {
        this.log('✅ Server is running and healthy', 'green');
        this.log(`📍 Server URL: ${CONFIG.BASE_URL}`, 'blue');
      } else {
        this.log('⚠️  Server responded with non-200 status', 'yellow');
      }
    } catch (error) {
      this.log('❌ Server is not accessible', 'red');
      this.log(`💡 Make sure your server is running at: ${CONFIG.BASE_URL}`, 'blue');
      return false;
    }

    return true;
  }

  async runCustomLoadTest() {
    this.logSection('Running Custom Load Test');
    
    return new Promise((resolve, reject) => {
      const startTime = performance.now();
      
      this.log('🚀 Starting custom load test for 30,000 users...', 'blue');
      
      const child = spawn('node', ['load-test-30000-users.js'], {
        stdio: 'pipe',
        env: { ...process.env, BASE_URL: CONFIG.BASE_URL }
      });

      let output = '';
      let errorOutput = '';

      child.stdout.on('data', (data) => {
        const message = data.toString();
        output += message;
        process.stdout.write(message);
      });

      child.stderr.on('data', (data) => {
        const message = data.toString();
        errorOutput += message;
        process.stderr.write(message);
      });

      child.on('close', (code) => {
        const endTime = performance.now();
        const duration = endTime - startTime;
        
        if (code === 0) {
          this.log(`\n✅ Custom load test completed successfully in ${(duration / 1000).toFixed(2)}s`, 'green');
          
          // Try to read the results file
          try {
            if (fs.existsSync('load-test-30000-report.json')) {
              const results = JSON.parse(fs.readFileSync('load-test-30000-report.json', 'utf8'));
              this.results.custom = results;
              this.log('📊 Custom test results loaded', 'green');
            }
          } catch (error) {
            this.log('⚠️  Could not load custom test results', 'yellow');
          }
          
          resolve();
        } else {
          this.log(`\n❌ Custom load test failed with code ${code}`, 'red');
          if (errorOutput) {
            this.log('Error output:', 'red');
            this.log(errorOutput, 'red');
          }
          reject(new Error(`Custom load test failed with code ${code}`));
        }
      });

      child.on('error', (error) => {
        this.log(`\n❌ Failed to start custom load test: ${error.message}`, 'red');
        reject(error);
      });
    });
  }

  async runArtilleryLoadTest() {
    this.logSection('Running Artillery Load Test');
    
    return new Promise((resolve, reject) => {
      const startTime = performance.now();
      
      this.log('🚀 Starting Artillery load test...', 'blue');
      
      const child = spawn('npx', ['artillery', 'run', 'artillery-config-30000-users.yml'], {
        stdio: 'pipe',
        env: { ...process.env, BASE_URL: CONFIG.BASE_URL }
      });

      let output = '';
      let errorOutput = '';

      child.stdout.on('data', (data) => {
        const message = data.toString();
        output += message;
        process.stdout.write(message);
      });

      child.stderr.on('data', (data) => {
        const message = data.toString();
        errorOutput += message;
        process.stderr.write(message);
      });

      child.on('close', (code) => {
        const endTime = performance.now();
        const duration = endTime - startTime;
        
        if (code === 0) {
          this.log(`\n✅ Artillery load test completed successfully in ${(duration / 1000).toFixed(2)}s`, 'green');
          
          // Try to parse Artillery output for results
          try {
            const lines = output.split('\n');
            const results = {
              output: output,
              duration: duration,
              timestamp: new Date().toISOString()
            };
            
            // Extract key metrics from Artillery output
            for (const line of lines) {
              if (line.includes('All virtual users finished')) {
                results.completionMessage = line.trim();
              }
              if (line.includes('HTTP 200')) {
                results.http200Count = line.trim();
              }
              if (line.includes('HTTP 4xx')) {
                results.http4xxCount = line.trim();
              }
              if (line.includes('HTTP 5xx')) {
                results.http5xxCount = line.trim();
              }
            }
            
            this.results.artillery = results;
            this.log('📊 Artillery test results captured', 'green');
          } catch (error) {
            this.log('⚠️  Could not parse Artillery results', 'yellow');
          }
          
          resolve();
        } else {
          this.log(`\n❌ Artillery load test failed with code ${code}`, 'red');
          if (errorOutput) {
            this.log('Error output:', 'red');
            this.log(errorOutput, 'red');
          }
          reject(new Error(`Artillery load test failed with code ${code}`));
        }
      });

      child.on('error', (error) => {
        this.log(`\n❌ Failed to start Artillery load test: ${error.message}`, 'red');
        reject(error);
      });
    });
  }

  async createOutputDirectory() {
    if (!fs.existsSync(CONFIG.OUTPUT_DIR)) {
      fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });
      this.log(`📁 Created output directory: ${CONFIG.OUTPUT_DIR}`, 'green');
    }
  }

  async saveResults() {
    this.logSection('Saving Test Results');
    
    await this.createOutputDirectory();
    
    // Save custom test results
    if (this.results.custom) {
      const customPath = path.join(CONFIG.OUTPUT_DIR, CONFIG.REPORTS.CUSTOM);
      fs.writeFileSync(customPath, JSON.stringify(this.results.custom, null, 2));
      this.log(`💾 Custom test results saved to: ${customPath}`, 'green');
    }

    // Save Artillery test results
    if (this.results.artillery) {
      const artilleryPath = path.join(CONFIG.OUTPUT_DIR, CONFIG.REPORTS.ARTILLERY);
      fs.writeFileSync(artilleryPath, JSON.stringify(this.results.artillery, null, 2));
      this.log(`💾 Artillery test results saved to: ${artilleryPath}`, 'green');
    }

    // Generate summary report
    await this.generateSummaryReport();
  }

  async generateSummaryReport() {
    const summaryPath = path.join(CONFIG.OUTPUT_DIR, CONFIG.REPORTS.SUMMARY);
    
    let summary = `# Load Test Summary Report\n\n`;
    summary += `**Generated:** ${new Date().toLocaleString()}\n`;
    summary += `**Base URL:** ${CONFIG.BASE_URL}\n`;
    summary += `**Total Users:** 30,000\n\n`;

    // Custom test summary
    if (this.results.custom) {
      summary += `## Custom Load Test Results\n\n`;
      summary += `- **Start Time:** ${this.results.custom.startTime}\n`;
      summary += `- **End Time:** ${this.results.custom.endTime}\n`;
      summary += `- **Total Requests:** ${this.results.custom.totalRequests}\n`;
      summary += `- **Successful Requests:** ${this.results.custom.successfulRequests}\n`;
      summary += `- **Failed Requests:** ${this.results.custom.failedRequests}\n`;
      summary += `- **Success Rate:** ${((this.results.custom.successfulRequests / this.results.custom.totalRequests) * 100).toFixed(2)}%\n`;
      summary += `- **Average Response Time:** ${this.results.custom.averageResponseTime.toFixed(2)}ms\n`;
      summary += `- **Min Response Time:** ${this.results.custom.minResponseTime.toFixed(2)}ms\n`;
      summary += `- **Max Response Time:** ${this.results.custom.maxResponseTime.toFixed(2)}ms\n\n`;

      // Endpoint performance
      if (this.results.custom.endpointPerformance) {
        summary += `### Endpoint Performance\n\n`;
        Object.entries(this.results.custom.endpointPerformance).forEach(([endpoint, stats]) => {
          const successRate = ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(2);
          summary += `- **${endpoint}:** ${stats.totalRequests} requests, ${successRate}% success, ${stats.averageResponseTime.toFixed(2)}ms avg\n`;
        });
        summary += `\n`;
      }
    }

    // Artillery test summary
    if (this.results.artillery) {
      summary += `## Artillery Load Test Results\n\n`;
      summary += `- **Duration:** ${(this.results.artillery.duration / 1000).toFixed(2)}s\n`;
      summary += `- **Timestamp:** ${this.results.artillery.timestamp}\n`;
      if (this.results.artillery.completionMessage) {
        summary += `- **Status:** ${this.results.artillery.completionMessage}\n`;
      }
      summary += `\n`;
    }

    // Recommendations
    summary += `## Recommendations\n\n`;
    if (this.results.custom) {
      const successRate = (this.results.custom.successfulRequests / this.results.custom.totalRequests) * 100;
      if (successRate < 95) {
        summary += `⚠️ **Low Success Rate:** The success rate is ${successRate.toFixed(2)}%, which is below the recommended 95%.\n`;
        summary += `   - Investigate failed requests and errors\n`;
        summary += `   - Check server logs for issues\n`;
        summary += `   - Consider increasing server resources\n\n`;
      }

      if (this.results.custom.averageResponseTime > 1000) {
        summary += `⚠️ **High Response Time:** Average response time is ${this.results.custom.averageResponseTime.toFixed(2)}ms, which is above the recommended 1000ms.\n`;
        summary += `   - Optimize database queries\n`;
        summary += `   - Implement caching strategies\n`;
        summary += `   - Consider horizontal scaling\n\n`;
      }
    }

    summary += `## Next Steps\n\n`;
    summary += `1. Analyze detailed results in the JSON files\n`;
    summary += `2. Identify performance bottlenecks\n`;
    summary += `3. Implement optimizations\n`;
    summary += `4. Re-run tests to measure improvements\n`;

    fs.writeFileSync(summaryPath, summary);
    this.log(`📝 Summary report generated: ${summaryPath}`, 'green');
  }

  async run(testType = CONFIG.TEST_TYPES.BOTH) {
    this.startTime = new Date();
    
    this.logHeader('🚀 LOAD TESTING SUITE FOR 30,000 USERS');
    this.log(`📍 Target Server: ${CONFIG.BASE_URL}`, 'blue');
    this.log(`🕐 Start Time: ${this.startTime.toLocaleString()}`, 'blue');
    this.log(`🎯 Test Type: ${testType}`, 'blue');

    // Check prerequisites
    const prerequisitesOk = await this.checkPrerequisites();
    if (!prerequisitesOk) {
      this.log('❌ Prerequisites check failed. Please fix the issues above and try again.', 'red');
      process.exit(1);
    }

    try {
      // Run tests based on type
      if (testType === CONFIG.TEST_TYPES.CUSTOM || testType === CONFIG.TEST_TYPES.BOTH) {
        await this.runCustomLoadTest();
      }

      if (testType === CONFIG.TEST_TYPES.ARTILLERY || testType === CONFIG.TEST_TYPES.BOTH) {
        await this.runArtilleryLoadTest();
      }

      // Save results
      await this.saveResults();

      this.endTime = new Date();
      const totalDuration = (this.endTime - this.startTime) / 1000;

      this.logHeader('🎯 LOAD TESTING COMPLETED SUCCESSFULLY');
      this.log(`✅ All tests completed successfully`, 'green');
      this.log(`⏱️  Total Duration: ${totalDuration.toFixed(2)} seconds`, 'green');
      this.log(`📊 Results saved to: ${CONFIG.OUTPUT_DIR}`, 'green');
      this.log(`📝 Summary report: ${CONFIG.REPORTS.SUMMARY}`, 'green');

    } catch (error) {
      this.logHeader('❌ LOAD TESTING FAILED');
      this.log(`Error: ${error.message}`, 'red');
      process.exit(1);
    }
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  let testType = CONFIG.TEST_TYPES.BOTH;

  // Parse command line arguments
  if (args.includes('--custom-only')) {
    testType = CONFIG.TEST_TYPES.CUSTOM;
  } else if (args.includes('--artillery-only')) {
    testType = CONFIG.TEST_TYPES.ARTILLERY;
  } else if (args.includes('--help') || args.includes('-h')) {
    console.log(`
🚀 Load Testing Suite for 30,000 Users

Usage: node run-load-tests.js [options]

Options:
  --custom-only      Run only the custom load test
  --artillery-only   Run only the Artillery load test
  --both            Run both tests (default)
  --help, -h        Show this help message

Environment Variables:
  BASE_URL          Target server URL (default: http://localhost:8080)

Examples:
  node run-load-tests.js                    # Run both tests
  node run-load-tests.js --custom-only      # Run only custom test
  node run-load-tests.js --artillery-only   # Run only Artillery test
  BASE_URL=https://your-server.com node run-load-tests.js  # Test remote server

The suite will:
1. Check prerequisites (Node.js, packages, server health)
2. Run load tests for 30,000 users
3. Generate comprehensive reports
4. Save results to ./load-test-results/
`);
    process.exit(0);
  }

  const runner = new LoadTestRunner();
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT, stopping load tests...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM, stopping load tests...');
    process.exit(0);
  });

  await runner.run(testType);
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  });
}

export { LoadTestRunner };
