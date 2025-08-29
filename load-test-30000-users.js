import axios from 'axios';
import { performance } from 'perf_hooks';
import fs from 'fs';

// Configuration
const CONFIG = {
  BASE_URL: 'https://tuktukiapp-dev-219733694412.asia-south1.run.app',
  TOTAL_USERS: 30000,
  CONCURRENT_USERS: 500, // Reduced for better server handling
  DELAY_BETWEEN_BATCHES: 200, // ms
  OUTPUT_FILE: 'load-test-30000-summary-report.json'
};

// Test data generator
class TestDataGenerator {
  static generateMobileNumber() {
    const prefixes = ['6', '7', '8', '9'];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const remaining = Math.floor(Math.random() * 90000000) + 10000000;
    return `${prefix}${remaining}`;
  }

  static generateDeviceId() {
    return `device_${Math.random().toString(36).substr(2, 9)}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  }

  static generateUserData() {
    return {
      name: `User_${Math.random().toString(36).substr(2, 6)}`,
      email: `user_${Math.random().toString(36).substr(2, 8)}@test.com`,
      mobile: this.generateMobileNumber(),
      device_id: this.generateDeviceId()
    };
  }
}

// API test scenarios using ONLY existing routes
class APITestScenarios {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.userSessions = new Map(); // device_id -> user data
  }

  // Step 1: Create user profile with device ID via OTP
  async createUserProfile(userData) {
    try {
      const startTime = performance.now();
      
      // First send OTP
      const otpResponse = await axios.post(`${this.baseUrl}/api/sms/send-otp`, {
        mobile: userData.mobile
      });

      if (otpResponse.status !== 200) {
        throw new Error(`OTP send failed: ${otpResponse.status}`);
      }

      const otp = otpResponse.data.data;
      
      // Then verify OTP and create user
      const verifyResponse = await axios.post(`${this.baseUrl}/api/sms/verify-otp`, {
        mobile: userData.mobile,
        otp: otp
      }, {
        headers: {
          'x-device-id': userData.device_id
        }
      });

      const endTime = performance.now();
      
      if (verifyResponse.status === 200 && verifyResponse.data.user) {
        // Store user session
        this.userSessions.set(userData.device_id, {
          ...verifyResponse.data.user,
          token: verifyResponse.data.token,
          device_id: userData.device_id
        });

        return {
          success: true,
          responseTime: endTime - startTime,
          statusCode: verifyResponse.status,
          user: verifyResponse.data.user,
          token: verifyResponse.data.token,
          error: null
        };
      } else {
        throw new Error('User creation failed');
      }
    } catch (error) {
      return {
        success: false,
        responseTime: 0,
        statusCode: error.response?.status || 0,
        user: null,
        token: null,
        error: error.message
      };
    }
  }

  // Step 2: Test reward tasks API (EXISTS: /api/task/reward_task)
  async testRewardTasks(deviceId) {
    try {
      const userSession = this.userSessions.get(deviceId);
      if (!userSession || !userSession.token) {
        return { success: false, error: 'No valid user session' };
      }

      const startTime = performance.now();
      const response = await axios.get(`${this.baseUrl}/api/task/reward_task`, {
        headers: {
          'Authorization': `Bearer ${userSession.token}`,
          'x-device-id': deviceId
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

  // Step 3: Test user transactions API (EXISTS: /api/task/user-transaction)
  async testUserTransactions(deviceId) {
    try {
      const userSession = this.userSessions.get(deviceId);
      if (!userSession || !userSession.token) {
        return { success: false, error: 'No valid user session' };
      }

      const startTime = performance.now();
      const response = await axios.get(`${this.baseUrl}/api/task/user-transaction`, {
        headers: {
          'Authorization': `Bearer ${userSession.token}`,
          'x-device-id': deviceId
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

  // Step 4: Test series API (EXISTS: /api/series)
  async testSeries(deviceId) {
    try {
      const userSession = this.userSessions.get(deviceId);
      if (!userSession || !userSession.token) {
        return { success: false, error: 'No valid user session' };
      }

      const startTime = performance.now();
      const response = await axios.get(`${this.baseUrl}/api/series`, {
        headers: {
          'Authorization': `Bearer ${userSession.token}`,
          'x-device-id': deviceId
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

  // Step 5: Test episodes API (EXISTS: /api/episodes)
  async testEpisodes(deviceId) {
    try {
      const userSession = this.userSessions.get(deviceId);
      if (!userSession || !userSession.token) {
        return { success: false, error: 'No valid user session' };
      }

      const startTime = performance.now();
      const response = await axios.get(`${this.baseUrl}/api/episodes`, {
        headers: {
          'Authorization': `Bearer ${userSession.token}`,
          'x-device-id': deviceId
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

  // Step 6: Test user profile API (EXISTS: /api/profile)
  async testUserProfile(deviceId) {
    try {
      const userSession = this.userSessions.get(deviceId);
      if (!userSession || !userSession.token) {
        return { success: false, error: 'No valid user session' };
      }

      const startTime = performance.now();
      const response = await axios.get(`${this.baseUrl}/api/profile`, {
        headers: {
          'Authorization': `Bearer ${userSession.token}`,
          'x-device-id': deviceId
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

  // Step 7: Test search API (EXISTS: /api/search)
  async testSearch(deviceId) {
    try {
      const userSession = this.userSessions.get(deviceId);
      if (!userSession || !userSession.token) {
        return { success: false, error: 'No valid user session' };
      }

      const startTime = performance.now();
      const response = await axios.get(`${this.baseUrl}/api/search?q=test`, {
        headers: {
          'Authorization': `Bearer ${userSession.token}`,
          'x-device-id': deviceId
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

  // Step 8: Test about us static content API (EXISTS: /api/static/about-us)
  async testAboutUs(deviceId) {
    try {
      const userSession = this.userSessions.get(deviceId);
      if (!userSession || !userSession.token) {
        return { success: false, error: 'No valid user session' };
      }

      const startTime = performance.now();
      const response = await axios.get(`${this.baseUrl}/api/static/about-us`, {
        headers: {
          'Authorization': `Bearer ${userSession.token}`,
          'x-device-id': deviceId
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

  // Step 9: Test episode bundles API (EXISTS: /api/episode-bundles)
  async testEpisodeBundles(deviceId) {
    try {
      const userSession = this.userSessions.get(deviceId);
      if (!userSession || !userSession.token) {
        return { success: false, error: 'No valid user session' };
      }

      const startTime = performance.now();
      const response = await axios.get(`${this.baseUrl}/api/episode-bundles`, {
        headers: {
          'Authorization': `Bearer ${userSession.token}`,
          'x-device-id': deviceId
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
  constructor() {
    this.config = CONFIG;
    this.results = {
      startTime: null,
      endTime: null,
      totalUsers: 0,
      successfulUsers: 0,
      failedUsers: 0,
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
      userFlowResults: [],
      apiDataSamples: {}
    };
    this.testScenarios = new APITestScenarios(this.config.BASE_URL);
    this.isRunning = false;
  }

  async runUserFlow(userData) {
    const userFlow = {
      userId: userData.mobile,
      deviceId: userData.device_id,
      steps: [],
      totalTime: 0,
      success: true,
      finalUserData: null
    };

    const startTime = performance.now();

    // Step 1: Create user profile
    console.log(`👤 Creating user profile for ${userData.mobile}...`);
    const profileResult = await this.testScenarios.createUserProfile(userData);
    userFlow.steps.push({
      step: 'create_user_profile',
      ...profileResult
    });

    if (!profileResult.success) {
      userFlow.success = false;
      userFlow.totalTime = performance.now() - startTime;
      return userFlow;
    }

    // Store user data for API testing
    userFlow.finalUserData = profileResult.user;
    console.log(`✅ User created: ${profileResult.user.id}`);

    // Step 2: Test reward tasks
    console.log(`🎯 Testing reward tasks for ${userData.device_id}...`);
    const rewardResult = await this.testScenarios.testRewardTasks(userData.device_id);
    userFlow.steps.push({
      step: 'reward_tasks',
      ...rewardResult
    });

    // Step 3: Test user transactions
    console.log(`💰 Testing user transactions for ${userData.device_id}...`);
    const transactionResult = await this.testScenarios.testUserTransactions(userData.device_id);
    userFlow.steps.push({
      step: 'user_transactions',
      ...transactionResult
    });

    // Step 4: Test series
    console.log(`📺 Testing series for ${userData.device_id}...`);
    const seriesResult = await this.testScenarios.testSeries(userData.device_id);
    userFlow.steps.push({
      step: 'series',
      ...seriesResult
    });

    // Step 5: Test episodes
    console.log(`🎭 Testing episodes for ${userData.device_id}...`);
    const episodeResult = await this.testScenarios.testEpisodes(userData.device_id);
    userFlow.steps.push({
      step: 'episodes',
      ...episodeResult
    });

    // Step 6: Test user profile
    console.log(`👤 Testing user profile for ${userData.device_id}...`);
    const userProfileResult = await this.testScenarios.testUserProfile(userData.device_id);
    userFlow.steps.push({
      step: 'user_profile',
      ...userProfileResult
    });

    // Step 7: Test search
    console.log(`🔍 Testing search for ${userData.device_id}...`);
    const searchResult = await this.testScenarios.testSearch(userData.device_id);
    userFlow.steps.push({
      step: 'search',
      ...searchResult
    });

    // Step 8: Test about us
    console.log(`📄 Testing about us for ${userData.device_id}...`);
    const aboutResult = await this.testScenarios.testAboutUs(userData.device_id);
    userFlow.steps.push({
      step: 'about_us',
      ...aboutResult
    });

    // Step 9: Test episode bundles
    console.log(`📦 Testing episode bundles for ${userData.device_id}...`);
    const bundleResult = await this.testScenarios.testEpisodeBundles(userData.device_id);
    userFlow.steps.push({
      step: 'episode_bundles',
      ...bundleResult
    });

    userFlow.totalTime = performance.now() - startTime;
    console.log(`🎉 User flow completed for ${userData.device_id} in ${userFlow.totalTime.toFixed(2)}ms`);
    
    return userFlow;
  }

  async runBatch(userCount) {
    const users = Array.from({ length: userCount }, () => TestDataGenerator.generateUserData());
    const promises = users.map(userData => this.runUserFlow(userData));
    
    const results = await Promise.all(promises);
    return results;
  }

  updateResults(userFlowResults) {
    userFlowResults.forEach(userFlow => {
      if (userFlow.success) {
        this.results.successfulUsers++;
      } else {
        this.results.failedUsers++;
      }

      this.results.totalUsers++;
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

          // Store only essential sample data structure, not full data
          if (step.data && !this.results.apiDataSamples[step.step]) {
            this.results.apiDataSamples[step.step] = {
              hasData: true,
              dataType: typeof step.data,
              isArray: Array.isArray(step.data),
              timestamp: new Date().toISOString()
            };
          }
        } else {
          this.results.failedRequests++;
          if (step.error) {
            this.results.errors.push({
              userId: userFlow.userId,
              deviceId: userFlow.deviceId,
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

      // Store only essential user flow summary, not full details
      this.results.userFlowResults.push({
        userId: userFlow.userId,
        deviceId: userFlow.deviceId,
        success: userFlow.success,
        totalTime: userFlow.totalTime,
        stepsCount: userFlow.steps.length,
        successfulSteps: userFlow.steps.filter(step => step.success).length
      });
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
    
    console.log('🚀 Starting 30,000 User Load Test');
    console.log(`📊 Target Server: ${this.config.BASE_URL}`);
    console.log(`👥 Total Users: ${this.config.TOTAL_USERS}`);
    console.log(`⚡ Concurrent Users: ${this.config.CONCURRENT_USERS} users per batch`);
    console.log(`⏱️  Start Time: ${this.results.startTime.toLocaleString()}`);
    console.log(`🔗 Testing Routes: /api/sms/*, /api/task/*, /api/series, /api/episodes, /api/profile, /api/search, /api/static/*, /api/episode-bundles`);

    let processedUsers = 0;

    while (processedUsers < this.config.TOTAL_USERS && this.isRunning) {
      const remainingUsers = this.config.TOTAL_USERS - processedUsers;
      const batchSize = Math.min(this.config.CONCURRENT_USERS, remainingUsers);
      
      console.log(`\n📦 Processing batch ${Math.floor(processedUsers / this.config.CONCURRENT_USERS) + 1}: ${batchSize} users`);
      
      const batchResults = await this.runBatch(batchSize);
      this.updateResults(batchResults);
      
      processedUsers += batchSize;
      const progress = ((processedUsers / this.config.TOTAL_USERS) * 100).toFixed(2);
      
      console.log(`✅ Batch completed. Progress: ${progress}% (${processedUsers}/${this.config.TOTAL_USERS})`);
      console.log(`👥 Successful Users: ${this.results.successfulUsers}`);
      console.log(`❌ Failed Users: ${this.results.failedUsers}`);
      console.log(`📈 Successful Requests: ${this.results.successfulRequests}`);
      console.log(`❌ Failed Requests: ${this.results.failedRequests}`);
      console.log(`⏱️  Average Response Time: ${this.results.averageResponseTime.toFixed(2)}ms`);
      
      // Add delay between batches
      if (processedUsers < this.config.TOTAL_USERS) {
        console.log(`⏳ Waiting ${this.config.DELAY_BETWEEN_BATCHES}ms before next batch...`);
        await new Promise(resolve => setTimeout(resolve, this.config.DELAY_BETWEEN_BATCHES));
      }
    }

    this.results.endTime = new Date();
    this.isRunning = false;
    
    console.log('\n🎯 Load test completed!');
    this.printSummary();
    this.saveResults();
    console.log('\n📊 Summary report generated successfully!');
  }

  printSummary() {
    console.log('\n📊 LOAD TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(`Start Time: ${this.results.startTime}`);
    console.log(`End Time: ${this.results.endTime}`);
    console.log(`Total Duration: ${(this.results.endTime - this.results.startTime) / 1000} seconds`);
    console.log(`Total Users: ${this.results.totalUsers}`);
    console.log(`Successful Users: ${this.results.successfulUsers}`);
    console.log(`Failed Users: ${this.results.failedUsers}`);
    console.log(`User Success Rate: ${((this.results.successfulUsers / this.results.totalUsers) * 100).toFixed(2)}%`);
    console.log(`Total Requests: ${this.results.totalRequests}`);
    console.log(`Successful Requests: ${this.results.successfulRequests}`);
    console.log(`Failed Requests: ${this.results.failedRequests}`);
    console.log(`Request Success Rate: ${((this.results.successfulRequests / this.results.totalRequests) * 100).toFixed(2)}%`);
    console.log(`Average Response Time: ${this.results.averageResponseTime.toFixed(2)}ms`);
    console.log(`Min Response Time: ${this.results.minResponseTime.toFixed(2)}ms`);
    console.log(`Max Response Time: ${this.results.maxResponseTime.toFixed(2)}ms`);
    
    console.log('\n📈 ENDPOINT PERFORMANCE');
    console.log('-'.repeat(40));
    Object.entries(this.results.endpointPerformance).forEach(([endpoint, stats]) => {
      const successRate = ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(2);
      console.log(`${endpoint}:`);
      console.log(`  Requests: ${stats.totalRequests}`);
      console.log(`  Success Rate: ${successRate}%`);
      console.log(`  Avg Response Time: ${stats.averageResponseTime.toFixed(2)}ms`);
    });

    console.log('\n🔍 STATUS CODE DISTRIBUTION');
    console.log('-'.repeat(40));
    Object.entries(this.results.statusCodeDistribution)
      .sort(([a], [b]) => parseInt(a) - parseInt(b))
      .forEach(([statusCode, count]) => {
        const percentage = ((count / this.results.totalRequests) * 100).toFixed(2);
        console.log(`${statusCode}: ${count} (${percentage}%)`);
      });

    if (this.results.errors.length > 0) {
      console.log('\n❌ TOP ERRORS');
      console.log('-'.repeat(30));
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

    console.log('\n📊 API DATA SAMPLES');
    console.log('-'.repeat(30));
    Object.entries(this.results.apiDataSamples).forEach(([endpoint, data]) => {
      console.log(`${endpoint}:`);
      console.log(`  Sample data captured at: ${data.timestamp}`);
      console.log(`  Data structure: ${JSON.stringify(data.sample).substring(0, 100)}...`);
    });
  }

  saveResults() {
    try {
      // Create a summary report with only essential information
      const summaryReport = {
        testInfo: {
          startTime: this.results.startTime,
          endTime: this.results.endTime,
          duration: this.results.endTime ? (this.results.endTime - this.results.startTime) / 1000 : 0,
          baseUrl: this.config.BASE_URL,
          totalUsers: this.config.TOTAL_USERS,
          concurrentUsers: this.config.CONCURRENT_USERS
        },
        results: {
          totalUsers: this.results.totalUsers,
          successfulUsers: this.results.successfulUsers,
          failedUsers: this.results.failedUsers,
          userSuccessRate: this.results.totalUsers > 0 ? ((this.results.successfulUsers / this.results.totalUsers) * 100).toFixed(2) + '%' : '0%',
          totalRequests: this.results.totalRequests,
          successfulRequests: this.results.successfulRequests,
          failedRequests: this.results.failedRequests,
          requestSuccessRate: this.results.totalRequests > 0 ? ((this.results.successfulRequests / this.results.totalRequests) * 100).toFixed(2) + '%' : '0%'
        },
        performance: {
          averageResponseTime: this.results.averageResponseTime.toFixed(2) + 'ms',
          minResponseTime: this.results.minResponseTime === Infinity ? 'N/A' : this.results.minResponseTime.toFixed(2) + 'ms',
          maxResponseTime: this.results.maxResponseTime === 0 ? 'N/A' : this.results.maxResponseTime.toFixed(2) + 'ms'
        },
        endpointPerformance: Object.entries(this.results.endpointPerformance).map(([endpoint, stats]) => ({
          endpoint,
          totalRequests: stats.totalRequests,
          successfulRequests: stats.successfulRequests,
          failedRequests: stats.failedRequests,
          successRate: stats.totalRequests > 0 ? ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(2) + '%' : '0%',
          averageResponseTime: stats.averageResponseTime.toFixed(2) + 'ms'
        })),
        statusCodeDistribution: Object.entries(this.results.statusCodeDistribution)
          .sort(([a], [b]) => parseInt(a) - parseInt(b))
          .map(([statusCode, count]) => ({
            statusCode: parseInt(statusCode),
            count,
            percentage: ((count / this.results.totalRequests) * 100).toFixed(2) + '%'
          })),
        topErrors: this.results.errors.slice(0, 10).map(error => ({
          step: error.step,
          error: error.error,
          count: this.results.errors.filter(e => e.step === error.step && e.error === error.error).length
        })).filter((error, index, self) => 
          index === self.findIndex(e => e.step === error.step && e.error === error.error)
        ).sort((a, b) => b.count - a.count).slice(0, 10),
        apiDataSamples: Object.entries(this.results.apiDataSamples).map(([endpoint, data]) => ({
          endpoint,
          hasData: data.hasData,
          dataType: data.dataType,
          isArray: data.isArray,
          timestamp: data.timestamp
        }))
      };

      fs.writeFileSync(this.config.OUTPUT_FILE, JSON.stringify(summaryReport, null, 2));
      console.log(`\n💾 Summary report saved to ${this.config.OUTPUT_FILE}`);
      
      // Also save a minimal version for quick reference
      const minimalReport = {
        summary: `${this.results.successfulUsers}/${this.results.totalUsers} users successful (${((this.results.successfulUsers / this.results.totalUsers) * 100).toFixed(2)}%)`,
        requests: `${this.results.successfulRequests}/${this.results.totalRequests} requests successful (${((this.results.successfulRequests / this.results.totalRequests) * 100).toFixed(2)}%)`,
        avgResponseTime: `${this.results.averageResponseTime.toFixed(2)}ms`,
        duration: `${summaryReport.testInfo.duration.toFixed(2)}s`
      };
      
      const minimalFileName = this.config.OUTPUT_FILE.replace('.json', '-minimal.json');
      fs.writeFileSync(minimalFileName, JSON.stringify(minimalReport, null, 2));
      console.log(`📊 Minimal report saved to ${minimalFileName}`);
      
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
    console.log('🚀 Starting 30,000 User Load Test against Tuktuki App Server');
    console.log(`📍 Server: ${CONFIG.BASE_URL}`);
    console.log(`👥 Target: ${CONFIG.TOTAL_USERS} users`);
    console.log(`⚡ Concurrency: ${CONFIG.CONCURRENT_USERS} users per batch`);
    console.log(`🔗 Testing ONLY existing routes from your codebase`);
    
    const runner = new LoadTestRunner();
    
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

export { LoadTestRunner, APITestScenarios, TestDataGenerator };
