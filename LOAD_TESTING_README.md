# 🚀 Load Testing Suite for 30,000 Users

This comprehensive load testing suite is designed to test your mobile app backend server with realistic user scenarios and high concurrency loads.

## 📋 What's Included

### 1. **Custom Load Test Script** (`load-test-30000-users.js`)
- **Realistic User Flows**: Tests complete user journeys from OTP to video streaming
- **30,000 Users**: Configurable total user count
- **Concurrent Execution**: Up to 1,000 concurrent users (configurable)
- **Real Data Generation**: Creates realistic mobile numbers, device IDs, and user data
- **Comprehensive Metrics**: Response times, success rates, error tracking
- **Detailed Reporting**: JSON output with performance analytics

### 2. **Artillery Configuration** (`artillery-config-30000-users.yml`)
- **Professional Load Testing**: Industry-standard Artillery tool
- **Phased Testing**: Warm-up, ramp-up, sustained load, peak, ramp-down
- **Multiple Scenarios**: Authentication, video streaming, reward systems
- **Realistic User Behavior**: Think times and user flow weights
- **Performance Expectations**: Status code validation and response checks

### 3. **Test Runner** (`run-load-tests.js`)
- **Unified Interface**: Run both test types from one command
- **Prerequisites Check**: Validates server health and dependencies
- **Result Aggregation**: Combines results from multiple test types
- **Report Generation**: Creates comprehensive markdown summaries
- **Error Handling**: Graceful failure and detailed error reporting

### 4. **Health Check Endpoints** (`src/routes/healthRoutes.js`)
- **Server Monitoring**: Real-time health status
- **Load Test Endpoints**: Dedicated endpoints for testing
- **Performance Metrics**: Response time and service status

## 🛠️ Prerequisites

### Required Software
- **Node.js** 16+ (check with `node --version`)
- **npm** or **yarn** package manager
- **Your server running** and accessible

### Required Packages
```bash
# Install Artillery for professional load testing
npm install --save-dev artillery

# Ensure all dependencies are installed
npm install
```

### Server Requirements
- **Database**: PostgreSQL with connection pooling
- **Redis**: For caching and session management
- **Memory**: At least 4GB RAM recommended
- **CPU**: Multi-core processor recommended
- **Network**: Stable internet connection

## 🚀 Quick Start

### 1. **Start Your Server**
```bash
# Development mode
npm run dev

# Production mode
npm start
```

### 2. **Verify Server Health**
```bash
# Check if server is running
curl http://localhost:8080/api/health
```

### 3. **Run Load Tests**

#### **Option A: Run Complete Suite (Recommended)**
```bash
# Run both custom and Artillery tests
npm run load-test:suite

# Or directly
node run-load-tests.js
```

#### **Option B: Run Individual Tests**
```bash
# Custom load test only
npm run load-test:custom

# Artillery test only
npm run load-test:artillery-only

# Direct custom test
npm run load-test:30000-users

# Direct Artillery test
npm run load-test:artillery
```

#### **Option C: Test Remote Server**
```bash
# Test against production/staging server
BASE_URL=https://your-server.com npm run load-test:suite
```

## 📊 Test Scenarios

### **User Authentication Flow (40% weight)**
1. **Send OTP**: Generate and send OTP to mobile number
2. **Verify OTP**: Complete user authentication
3. **Get Reward Tasks**: Fetch available reward tasks
4. **User Profile**: Retrieve user information

### **Video Streaming Flow (35% weight)**
1. **User Authentication**: Complete OTP flow
2. **Browse Videos**: Get video catalog
3. **Video Categories**: Fetch video categories
4. **Video Details**: Get specific video information

### **Reward System Flow (25% weight)**
1. **User Authentication**: Complete OTP flow
2. **Reward Tasks**: Get available tasks
3. **User Progress**: Check task completion status
4. **Reward History**: View reward transactions

## ⚙️ Configuration

### **Custom Load Test Configuration**
```javascript
// In load-test-30000-users.js
const CONFIG = {
  BASE_URL: process.env.BASE_URL || 'http://localhost:8080',
  TOTAL_USERS: 30000,                    // Total users to test
  CONCURRENT_USERS: 1000,                // Concurrent users per batch
  DELAY_BETWEEN_REQUESTS: 100,           // Delay between batches (ms)
  TEST_DURATION: 300000,                 // Maximum test duration (ms)
  OUTPUT_FILE: 'load-test-30000-report.json'
};
```

### **Artillery Configuration**
```yaml
# In artillery-config-30000-users.yml
phases:
  - duration: 60
    arrivalRate: 50      # 50 users/sec for 1 minute
  - duration: 120
    arrivalRate: 100     # 100 users/sec for 2 minutes
  - duration: 300
    arrivalRate: 200     # 200 users/sec for 5 minutes
  - duration: 180
    arrivalRate: 500     # 500 users/sec for 3 minutes (peak)
  - duration: 120
    arrivalRate: 200     # 200 users/sec for 2 minutes
  - duration: 60
    arrivalRate: 50      # 50 users/sec for 1 minute
```

### **Environment Variables**
```bash
# Set your server URL
export BASE_URL=http://localhost:8080

# Or for production testing
export BASE_URL=https://your-production-server.com

# Node environment
export NODE_ENV=production
```

## 📈 Understanding Results

### **Custom Load Test Metrics**
- **Total Requests**: Complete API calls made
- **Success Rate**: Percentage of successful requests
- **Response Times**: Min, max, and average response times
- **Endpoint Performance**: Individual API endpoint statistics
- **Error Analysis**: Detailed error categorization

### **Artillery Metrics**
- **Virtual Users**: Concurrent users simulated
- **Request Rates**: Requests per second
- **Response Codes**: HTTP status code distribution
- **Latency Percentiles**: P50, P90, P95 response times
- **Throughput**: Requests processed per second

### **Performance Benchmarks**
| Metric | Excellent | Good | Acceptable | Poor |
|--------|-----------|------|------------|------|
| Success Rate | >99% | >95% | >90% | <90% |
| Avg Response Time | <200ms | <500ms | <1000ms | >1000ms |
| P95 Response Time | <500ms | <1000ms | <2000ms | >2000ms |
| Error Rate | <1% | <5% | <10% | >10% |

## 🔧 Troubleshooting

### **Common Issues**

#### **Server Not Accessible**
```bash
# Check if server is running
curl http://localhost:8080/api/health

# Check server logs
npm run dev
```

#### **Database Connection Issues**
```bash
# Verify database connection
# Check your .env file for database credentials
# Ensure PostgreSQL is running
```

#### **Redis Connection Issues**
```bash
# Verify Redis connection
# Check Redis configuration in src/config/redis.js
# Ensure Redis server is running
```

#### **Memory Issues**
```bash
# Increase Node.js memory limit
node --max-old-space-size=4096 run-load-tests.js

# Monitor system resources
htop  # or top
```

#### **Network Issues**
```bash
# Test network connectivity
ping your-server.com

# Check firewall settings
# Verify DNS resolution
```

### **Performance Optimization**

#### **Server-Side**
- **Database Indexing**: Ensure proper database indexes
- **Connection Pooling**: Optimize database connection pools
- **Caching**: Implement Redis caching strategies
- **Load Balancing**: Consider horizontal scaling

#### **Client-Side**
- **Concurrent Users**: Adjust based on server capacity
- **Request Delays**: Increase delays for heavy loads
- **Batch Sizes**: Reduce batch sizes if server struggles

## 📁 Output Files

### **Generated Reports**
```
load-test-results/
├── custom-load-test-report.json    # Detailed custom test results
├── artillery-report.json           # Artillery test results
└── load-test-summary.md           # Human-readable summary
```

### **Report Analysis**
```bash
# View summary report
cat load-test-results/load-test-summary.md

# Analyze custom test results
cat load-test-results/custom-load-test-report.json | jq '.'

# Check Artillery results
cat load-test-results/artillery-report.json | jq '.'
```

## 🎯 Advanced Usage

### **Custom Test Scenarios**
```javascript
// Modify load-test-30000-users.js to add new scenarios
async function customUserFlow(userData) {
  // Add your custom test logic here
  const result = await this.testScenarios.customEndpoint(userData);
  return result;
}
```

### **Artillery Customization**
```yaml
# Modify artillery-config-30000-users.yml
scenarios:
  - name: "Custom Flow"
    weight: 20
    flow:
      - get:
          url: "/api/your-endpoint"
          headers:
            "Authorization": "Bearer {{ authToken }}"
```

### **Continuous Testing**
```bash
# Run tests every hour
while true; do
  npm run load-test:suite
  sleep 3600
done

# Or use cron jobs
# 0 * * * * cd /path/to/your/app && npm run load-test:suite
```

## 🔒 Security Considerations

### **Test Environment**
- **Separate Database**: Use dedicated test database
- **Mock External Services**: Avoid hitting real SMS/email services
- **Rate Limiting**: Implement proper rate limiting for test endpoints
- **Data Isolation**: Ensure test data doesn't affect production

### **Production Testing**
- **Scheduled Windows**: Test during low-traffic periods
- **Monitoring**: Set up alerts for performance degradation
- **Rollback Plan**: Have rollback strategy ready
- **Stakeholder Notification**: Inform team before production tests

## 📞 Support

### **Getting Help**
1. **Check Logs**: Review server and test logs
2. **Verify Configuration**: Ensure all settings are correct
3. **Test Incrementally**: Start with smaller user counts
4. **Monitor Resources**: Watch CPU, memory, and network usage

### **Performance Tuning**
- **Database Optimization**: Query optimization and indexing
- **Caching Strategy**: Implement Redis caching layers
- **Load Balancing**: Distribute load across multiple servers
- **CDN Integration**: Use CDN for static content

## 🎉 Success Metrics

### **Load Test Success Criteria**
- ✅ **Success Rate**: >95% of requests succeed
- ✅ **Response Time**: Average <500ms, P95 <1000ms
- ✅ **Error Rate**: <5% of requests fail
- ✅ **Resource Usage**: CPU <80%, Memory <80%
- ✅ **Database Performance**: Query response times <100ms
- ✅ **Redis Performance**: Cache hit rate >90%

### **Next Steps After Testing**
1. **Analyze Results**: Identify bottlenecks and issues
2. **Optimize Code**: Implement performance improvements
3. **Scale Infrastructure**: Add resources if needed
4. **Re-run Tests**: Validate improvements
5. **Monitor Production**: Set up performance monitoring

---

**Happy Load Testing! 🚀**

This suite will help you ensure your mobile app backend can handle 30,000 users with excellent performance and reliability.
