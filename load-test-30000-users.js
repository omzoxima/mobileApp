import axios from 'axios';
import { performance } from 'perf_hooks';
import fs from 'fs';
import path from 'path';

// Configuration
const CONFIG = {
  BASE_URL: process.env.BASE_URL || 'https://tuktukiapp-dev-219733694412.asia-south1.run.app',
  TOTAL_USERS: 30000,
  CONCURRENT_USERS: 1000, // Adjust based on your server capacity
  DELAY_BETWEEN_REQUESTS: 100, // ms
  TEST_DURATION: 300000, // 5 minutes
  OUTPUT_FILE: 'load-test-30000-report.json'
};

// Test data generators
class TestDataGenerator {
  static generateMobileNumber() {
    const prefixes = ['6', '7', '8', '9'];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const remaining = Math.floor(Math.random() * 90000000) + 10000000;
    return `${prefix}${remaining}`;
  }

  static generateDeviceId() {
    return `device_${Math.random().toString(36).substr(2, 9)}_${Date.now()}`;
  }

  static generateUserData() {
    return {
      name: `User_${Math.random().toString(36).substr(2, 6)}`,
      email: `user_${Math.random().toString(36).substr(2, 8)}@test.com`,
      mobile: this.generateMobileNumber(),
      device_id: this.generateDeviceId()
    };
  }

  static generateVideoData() {
    const categories = ['action', 'comedy', 'drama', 'thriller', 'romance'];
    return {
      title: `Video_${Math.random().toString(36).substr(2, 8)}`,
      category: categories[Math.floor(Math.random() * categories.length)],
      duration: Math.floor(Math.random() * 120) + 30
    };
  }
}

// Test scenarios
class TestScenarios {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.authTokens = new Map();
    this.userSessions = new Map();
  }

  async sendOTP(userData) {
    try {
      const startTime = performance.now();
      const response = await axios.post(`${this.baseUrl}/api/sms/send-otp`, {
        mobile: userData.mobile
      });
      const endTime = performance.now();
      
      return {
        success: response.status === 200,
        responseTime: endTime - startTime,
        statusCode: response.status,
        data: response.data,
        error: null
      };
    } catch (error) {
      return {
        success: false,
        responseTime: 0,
        statusCode: error.response?.status || 0,
        data: null,
        error: error.message
      };
    }
  }

  async verifyOTP(userData, otp) {
    try {
      const startTime = performance.now();
      const response = await axios.post(`${this.baseUrl}/api/sms/verify-otp`, {
        mobile: userData.mobile,
        otp: otp
      }, {
        headers: {
          'x-device-id': userData.device_id
        }
      });
      const endTime = performance.now();
      
      if (response.data.token) {
        this.authTokens.set(userData.mobile, response.data.token);
        this.userSessions.set(userData.mobile, response.data.user);
      }
      
      return {
        success: response.status === 200,
        responseTime: endTime - startTime,
        statusCode: response.status,
        data: response.data,
        error: null
      };
    } catch (error) {
      return {
        success: false,
        responseTime: 0,
        statusCode: error.response?.status || 0,
        data: null,
        error: error.message
      };
    }
  }

  async getRewardTasks(userData) {
    try {
      const token = this.authTokens.get(userData.mobile);
      if (!token) {
        return { success: false, error: 'No auth token' };
      }

      const startTime = performance.now();
      const response = await axios.get(`${this.baseUrl}/api/task/reward-tasks`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'x-device-id': userData.device_id
        }
      });
      const endTime = performance.now();
      
      return {
        success: response.status === 200,
        responseTime: endTime - startTime,
        statusCode: response.status,
        data: response.data,
        error: null
      };
    } catch (error) {
      return {
        success: false,
        responseTime: 0,
        statusCode: error.response?.status || 0,
        data: null,
        error: error.message
      };
    }
  }

  async getVideos(userData) {
    try {
      const token = this.authTokens.get(userData.mobile);
      if (!token) {
        return { success: false, error: 'No auth token' };
      }

      const startTime = performance.now();
      const response = await axios.get(`${this.baseUrl}/api/videos`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'x-device-id': userData.device_id
        }
      });
      const endTime = performance.now();
      
      return {
        success: response.status === 200,
        responseTime: endTime - startTime,
        statusCode: response.status,
        data: response.data,
        error: null
      };
    } catch (error) {
      return {
        success: false,
        responseTime: 0,
        statusCode: error.response?.status || 0,
        data: null,
        error: error.message
      };
    }
  }

  async getMiscData(userData) {
    try {
      const token = this.authTokens.get(userData.mobile);
      if (!token) {
        return { success: false, error: 'No auth token' };
      }

      const startTime = performance.now();
      const response = await axios.get(`${this.baseUrl}/api/static-content`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'x-device-id': userData.device_id
        }
      });
      const endTime = performance.now();
      
      return {
        success: response.status === 200,
        responseTime: endTime - startTime,
        statusCode: response.status,
        data: response.data,
        error: null
      };
    } catch (error) {
      return {
        success: false,
        responseTime: 0,
        statusCode: error.response?.status || 0,
        data: null,
        error: error.message
      };
    }
  }
}

// Load Test Runner
class LoadTestRunner {
  constructor(config) {
    this.config = config;
    this.results = {
      startTime: null,
      endTime: null,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalResponseTime: 0,
      averageResponseTime: 0,
      minResponseTime: Infinity,
      maxResponseTime: 0,
      statusCodeDistribution: {},
      endpointPerformance: {},
      errors: [],
      userFlowResults: []
    };
    this.testScenarios = new TestScenarios(config.BASE_URL);
    this.currentUsers = 0;
    this.isRunning = false;
  }

  async runUserFlow(userData) {
    const userFlow = {
      userId: userData.mobile,
      deviceId: userData.device_id,
      steps: [],
      totalTime: 0,
      success: true
    };

    const startTime = performance.now();

    // Step 1: Send OTP
    const otpResult = await this.testScenarios.sendOTP(userData);
    userFlow.steps.push({
      step: 'send_otp',
      ...otpResult
    });

    if (!otpResult.success) {
      userFlow.success = false;
      userFlow.totalTime = performance.now() - startTime;
      return userFlow;
    }

    // Step 2: Verify OTP (using the OTP from response)
    const otp = otpResult.data?.data || '123456'; // Fallback OTP
    const verifyResult = await this.testScenarios.verifyOTP(userData, otp);
    userFlow.steps.push({
      step: 'verify_otp',
      ...verifyResult
    });

    if (!verifyResult.success) {
      userFlow.success = false;
      userFlow.totalTime = performance.now() - startTime;
      return userFlow;
    }

    // Step 3: Get Reward Tasks
    const rewardResult = await this.testScenarios.getRewardTasks(userData);
    userFlow.steps.push({
      step: 'get_reward_tasks',
      ...rewardResult
    });

    // Step 4: Get Videos
    const videoResult = await this.testScenarios.getVideos(userData);
    userFlow.steps.push({
      step: 'get_videos',
      ...videoResult
    });

    // Step 5: Get Misc Data
    const miscResult = await this.testScenarios.getMiscData(userData);
    userFlow.steps.push({
      step: 'get_misc_data',
      ...miscResult
    });

    userFlow.totalTime = performance.now() - startTime;
    return userFlow;
  }

  async runConcurrentUsers(userCount) {
    const users = Array.from({ length: userCount }, () => TestDataGenerator.generateUserData());
    const promises = users.map(userData => this.runUserFlow(userData));
    
    const results = await Promise.all(promises);
    return results;
  }

  updateResults(userFlowResults) {
    userFlowResults.forEach(userFlow => {
      this.results.totalRequests += userFlow.steps.length;
      
      userFlow.steps.forEach(step => {
        if (step.success) {
          this.results.successfulRequests++;
          this.results.totalResponseTime += step.responseTime;
          
          if (step.responseTime < this.results.minResponseTime) {
            this.results.minResponseTime = step.responseTime;
          }
          if (step.responseTime > this.results.maxResponseTime) {
            this.results.maxResponseTime = step.responseTime;
          }
        } else {
          this.results.failedRequests++;
          if (step.error) {
            this.results.errors.push({
              userId: userFlow.userId,
              step: step.step,
              error: step.error
            });
          }
        }

        // Update status code distribution
        const statusCode = step.statusCode || 0;
        this.results.statusCodeDistribution[statusCode] = 
          (this.results.statusCodeDistribution[statusCode] || 0) + 1;

        // Update endpoint performance
        if (!this.results.endpointPerformance[step.step]) {
          this.results.endpointPerformance[step.step] = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            totalResponseTime: 0,
            averageResponseTime: 0
          };
        }

        const endpoint = this.results.endpointPerformance[step.step];
        endpoint.totalRequests++;
        endpoint.totalResponseTime += step.responseTime;
        
        if (step.success) {
          endpoint.successfulRequests++;
        } else {
          endpoint.failedRequests++;
        }
      });

      this.results.userFlowResults.push(userFlow);
    });

    // Calculate averages
    if (this.results.successfulRequests > 0) {
      this.results.averageResponseTime = this.results.totalResponseTime / this.results.successfulRequests;
    }

    // Calculate endpoint averages
    Object.values(this.results.endpointPerformance).forEach(endpoint => {
      if (endpoint.successfulRequests > 0) {
        endpoint.averageResponseTime = endpoint.totalResponseTime / endpoint.successfulRequests;
      }
    });
  }

  async run() {
    if (this.isRunning) {
      console.log('Load test is already running');
      return;
    }

    this.isRunning = true;
    this.results.startTime = new Date();
    console.log(`🚀 Starting load test for ${this.config.TOTAL_USERS} users`);
    console.log(`📊 Base URL: ${this.config.BASE_URL}`);
    console.log(`⚡ Concurrent users: ${this.config.CONCURRENT_USERS}`);
    console.log(`⏱️  Test duration: ${this.config.TEST_DURATION / 1000} seconds`);

    const startTime = performance.now();
    let processedUsers = 0;

    while (processedUsers < this.config.TOTAL_USERS && this.isRunning) {
      const remainingUsers = this.config.TOTAL_USERS - processedUsers;
      const batchSize = Math.min(this.config.CONCURRENT_USERS, remainingUsers);
      
      console.log(`\n📦 Processing batch ${Math.floor(processedUsers / this.config.CONCURRENT_USERS) + 1}: ${batchSize} users`);
      
      const batchResults = await this.runConcurrentUsers(batchSize);
      this.updateResults(batchResults);
      
      processedUsers += batchSize;
      const progress = ((processedUsers / this.config.TOTAL_USERS) * 100).toFixed(2);
      
      console.log(`✅ Batch completed. Progress: ${progress}% (${processedUsers}/${this.config.TOTAL_USERS})`);
      console.log(`📈 Successful requests: ${this.results.successfulRequests}`);
      console.log(`❌ Failed requests: ${this.results.failedRequests}`);
      console.log(`⏱️  Average response time: ${this.results.averageResponseTime.toFixed(2)}ms`);
      
      // Check if we've exceeded test duration
      if (performance.now() - startTime > this.config.TEST_DURATION) {
        console.log('⏰ Test duration exceeded, stopping...');
        break;
      }

      // Add delay between batches
      if (processedUsers < this.config.TOTAL_USERS) {
        await new Promise(resolve => setTimeout(resolve, this.config.DELAY_BETWEEN_REQUESTS));
      }
    }

    this.results.endTime = new Date();
    this.isRunning = false;
    
    console.log('\n🎯 Load test completed!');
    this.printSummary();
    this.saveResults();
  }

  printSummary() {
    console.log('\n📊 LOAD TEST SUMMARY');
    console.log('='.repeat(50));
    console.log(`Start Time: ${this.results.startTime}`);
    console.log(`End Time: ${this.results.endTime}`);
    console.log(`Total Duration: ${(this.results.endTime - this.results.startTime) / 1000} seconds`);
    console.log(`Total Requests: ${this.results.totalRequests}`);
    console.log(`Successful Requests: ${this.results.successfulRequests}`);
    console.log(`Failed Requests: ${this.results.failedRequests}`);
    console.log(`Success Rate: ${((this.results.successfulRequests / this.results.totalRequests) * 100).toFixed(2)}%`);
    console.log(`Average Response Time: ${this.results.averageResponseTime.toFixed(2)}ms`);
    console.log(`Min Response Time: ${this.results.minResponseTime.toFixed(2)}ms`);
    console.log(`Max Response Time: ${this.results.maxResponseTime.toFixed(2)}ms`);
    
    console.log('\n📈 ENDPOINT PERFORMANCE');
    console.log('-'.repeat(30));
    Object.entries(this.results.endpointPerformance).forEach(([endpoint, stats]) => {
      const successRate = ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(2);
      console.log(`${endpoint}:`);
      console.log(`  Requests: ${stats.totalRequests}`);
      console.log(`  Success Rate: ${successRate}%`);
      console.log(`  Avg Response Time: ${stats.averageResponseTime.toFixed(2)}ms`);
    });

    console.log('\n🔍 STATUS CODE DISTRIBUTION');
    console.log('-'.repeat(30));
    Object.entries(this.results.statusCodeDistribution)
      .sort(([a], [b]) => parseInt(a) - parseInt(b))
      .forEach(([statusCode, count]) => {
        const percentage = ((count / this.results.totalRequests) * 100).toFixed(2);
        console.log(`${statusCode}: ${count} (${percentage}%)`);
      });

    if (this.results.errors.length > 0) {
      console.log('\n❌ TOP ERRORS');
      console.log('-'.repeat(20));
      const errorCounts = {};
      this.results.errors.forEach(error => {
        const key = `${error.step}: ${error.error}`;
        errorCounts[key] = (errorCounts[key] || 0) + 1;
      });
      
      Object.entries(errorCounts)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 10)
        .forEach(([error, count]) => {
          console.log(`${error}: ${count} occurrences`);
        });
    }
  }

  saveResults() {
    try {
      fs.writeFileSync(this.config.OUTPUT_FILE, JSON.stringify(this.results, null, 2));
      console.log(`\n💾 Results saved to ${this.config.OUTPUT_FILE}`);
    } catch (error) {
      console.error('Failed to save results:', error.message);
    }
  }

  stop() {
    this.isRunning = false;
    console.log('🛑 Load test stopped');
  }
}

// Main execution
async function main() {
  try {
    // Validate environment
    if (!process.env.BASE_URL) {
      console.log('⚠️  BASE_URL not set, using default: http://localhost:8080');
      console.log('💡 Set BASE_URL environment variable to test against your server');
    }

    const runner = new LoadTestRunner(CONFIG);
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n🛑 Received SIGINT, stopping load test...');
      runner.stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\n🛑 Received SIGTERM, stopping load test...');
      runner.stop();
      process.exit(0);
    });

    await runner.run();
    
  } catch (error) {
    console.error('❌ Load test failed:', error.message);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { LoadTestRunner, TestScenarios, TestDataGenerator };
