const express = require('express');
const cors = require('cors');
const { 
  scrapeMyntraProduct, 
  scrapeAmazonProduct, 
  scrapeFlipkartProduct, 
  regenerateCombinedJSON 
} = require('./scraper');
// Add these imports at the top with your other requires
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');

// Add to the top of server.js after your imports
const { browser } = require('./scraper');

// Ensure price-history directory exists
const priceHistoryDir = path.join(__dirname, 'price-history');
if (!fs.existsSync(priceHistoryDir)) {
  fs.mkdirSync(priceHistoryDir);
}

// Replace this line in server.js
// const pLimit = require('p-limit');

// With this code:
let pLimit;
(async () => {
  const module = await import('p-limit');
  pLimit = module.default;
})();

// Set up multer for file uploads
const upload = multer({ dest: 'uploads/' });
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Performance monitoring middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.url} - ${res.statusCode} - ${duration}ms`);
  });
  next();
});

// Serve static HTML page for testing
app.use(express.static('public'));

// API endpoint for scraping
app.get('/api/scrape', async (req, res) => {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).json({ 
      success: false, 
      error: 'URL parameter is required' 
    });
  }

  try {
    console.log(`Received request to scrape: ${url}`);
    
    // Add timeout to see if request is hanging
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Request timeout after 60s')), 60000)
    );
    
    // Race against timeout - use the wrapper function for Myntra
    const result = await Promise.race([
      scrapeMyntraProductWithHistory(url),
      timeoutPromise
    ]);
    
    return res.json(result);
  } catch (error) {
    console.error('Error in API endpoint:', error);
    console.error('Full error stack:', error.stack);
    return res.status(500).json({
      success: false,
      error: 'Server error while scraping',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Update the POST API endpoint for scraping to use a different timeout approach
app.post('/api/scrape', async (req, res) => {
  const { url, website = 'myntra' } = req.body;
  
  if (!url) {
    return res.status(400).json({ 
      success: false, 
      error: 'URL parameter is required' 
    });
  }

  // Add a special abort controller that can be used to abort the fetch operations
  const controller = new AbortController();
  const signal = controller.signal;
  
  // Set a timeout that will abort the operation
  const timeoutId = setTimeout(() => {
    console.log('Scraping operation taking too long, aborting...');
    controller.abort();
  }, 240000); // 4 minutes

  try {
    console.log(`Received POST request to scrape ${website} URL: ${url}`);
    
    // Explicitly increase Node.js server timeout
    req.socket.setTimeout(250000);
    res.setTimeout(250000);
    
    // Choose the appropriate scraping function based on website
    let scrapingFunction;
    switch (website) {
      case 'amazon':
        scrapingFunction = scrapeAmazonProduct;
        break;
      case 'flipkart':
        scrapingFunction = scrapeFlipkartProduct;
        break;
      case 'myntra':
      default:
        // Use the wrapper function for Myntra with streamlined operation
        scrapingFunction = url => scrapeMyntraProductWithRobustTimeout(url, signal);
    }
    
    // Progress logging
    const progressInterval = setInterval(() => {
      console.log(`[${new Date().toISOString()}] Scraping in progress for ${url}`);
    }, 10000); // Log every 10 seconds for better debugging
    
    // Execute the scraping function
    const result = await scrapingFunction(url);
    
    // Clean up
    clearTimeout(timeoutId);
    clearInterval(progressInterval);
    
    // Ensure a valid response even if result is somehow undefined
    if (!result) {
      throw new Error('Scraping completed but returned no data');
    }
    
    return res.json(result);
  } catch (error) {
    // Clean up
    clearTimeout(timeoutId);
    
    console.error('Error in API endpoint:', error);
    
    // Check if it was an abort error
    if (error.name === 'AbortError') {
      return res.status(500).json({
        success: false,
        error: 'Scraping operation timed out',
        details: 'The operation took too long to complete'
      });
    }
    
    // Check if headers have already been sent
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: 'Server error while scraping',
        details: error.message || 'Unknown error'
      });
    } else {
      console.error('Headers already sent, cannot send error response');
    }
  }
});

// Add this wrapper function to add a robust timeout to the scraping operation
async function scrapeMyntraProductWithRobustTimeout(url, signal) {
  return new Promise(async (resolve, reject) => {
    try {
      console.log(`Starting optimized scrape with robust timeout for: ${url}`);
      
      // Set up an internal timeout to prevent hanging
      const internalTimeoutId = setTimeout(() => {
        console.log(`Internal timeout reached for ${url}`);
        resolve({
          success: false,
          error: 'Scraping operation timed out internally',
          details: 'The operation took too long to complete at the browser level'
        });
      }, 90000); // 90 seconds internal timeout
      
      // Check if abort signal is already triggered
      if (signal && signal.aborted) {
        clearTimeout(internalTimeoutId);
        return resolve({
          success: false,
          error: 'Scraping operation aborted',
          details: 'The operation was aborted by the controller'
        });
      }
      
      // Set up signal handler
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(internalTimeoutId);
          resolve({
            success: false,
            error: 'Scraping operation aborted',
            details: 'The operation was aborted by the controller'
          });
        });
      }
      
      // Call the original scrape function
      try {
        const result = await scrapeMyntraProduct(url);
        clearTimeout(internalTimeoutId);
        resolve(result);
      } catch (error) {
        clearTimeout(internalTimeoutId);
        console.error('Error in scrapeMyntraProductWithRobustTimeout:', error);
        resolve({
          success: false,
          error: 'Failed to complete scraping operation',
          details: error.message || 'Unknown error'
        });
      }
    } catch (outerError) {
      console.error('Outer error in scrapeMyntraProductWithRobustTimeout:', outerError);
      resolve({
        success: false,
        error: 'Failed at wrapper level',
        details: outerError.message || 'Unknown wrapper error'
      });
    }
  });
}

// Replace your existing /api/upload-csv endpoint with this fixed implementation
app.post('/api/upload-csv', upload.single('csvFile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: 'No CSV file uploaded'
    });
  }

  const website = req.body.website || 'myntra';
  
  // Choose the appropriate scraping function based on website
  let scrapingFunction;
  switch (website) {
    case 'amazon':
      scrapingFunction = scrapeAmazonProduct;
      break;
    case 'flipkart':
      scrapingFunction = scrapeFlipkartProduct;
      break;
    case 'myntra':
    default:
      // Use the wrapper function for Myntra
      scrapingFunction = scrapeMyntraProductWithHistory;
  }

  try {
    const filePath = req.file.path;
    
    // Set up streaming response
    res.setHeader('Content-Type', 'application/json');
    res.write('{"success":true,"results":[');
    
    // Collect all product IDs first
    const productIds = [];
    await new Promise((resolve) => {
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (data) => {
          const productId = data.style_id || data.product_id;
          if (productId) {
            productIds.push(productId);
          }
        })
        .on('end', resolve);
    });
    
    console.log(`Found ${productIds.length} product IDs in CSV`);
    
    // Limit number of products to process (optional, for performance)
    const MAX_PRODUCTS_TO_PROCESS = 10000000;
    const productsToProcess = productIds.slice(0, MAX_PRODUCTS_TO_PROCESS);
    
    if (productsToProcess.length === 0) {
      // No products to process
      res.write(`],"totalProducts":0,"successfulScrapes":0,"failedScrapes":0,"errors":[]}`);
      res.end();
      return;
    }
    
    // Make sure pLimit is initialized before using it
    let limit;
    if (!pLimit) {
      console.error("pLimit not initialized - using a simple concurrency implementation");
      // Implement a simple concurrency control as fallback
      const createSimpleLimit = (max) => {
        let running = 0;
        const queue = [];
        
        const next = () => {
          if (running >= max || queue.length === 0) return;
          running++;
          const { fn, resolve, reject } = queue.shift();
          Promise.resolve(fn())
            .then(resolve)
            .catch(reject)
            .finally(() => {
              running--;
              next();
            });
        };
        
        return (fn) => new Promise((resolve, reject) => {
          queue.push({ fn, resolve, reject });
          next();
        });
      };
      
      limit = createSimpleLimit(5); // Fallback to simple implementation
    } else {
      limit = pLimit(5); // Use the proper p-limit module
    }
    
    let processedCount = 0;
    let successCount = 0;
    let failCount = 0;
    let isFirstResult = true;
    let errors = []; // Array to store error information

    // Process all products with concurrency
    await Promise.all(
      productsToProcess.map((productId) => {
        return limit(async () => {
          try {
            const url = `https://www.myntra.com/${productId}`;
            console.log(`Processing product ID: ${productId}`);
            
            const result = await scrapingFunction(url);
            
            // Synchronize writing to the response stream
            if (!isFirstResult) {
              res.write(',');
            } else {
              isFirstResult = false;
            }
            
            if (result && result.success) {
              res.write(JSON.stringify({
                productId,
                ...result.data
              }));
              successCount++;
            } else {
              const errorMsg = result ? result.error : 'Unknown error';
              const details = result ? result.details : 'No details available';
              
              res.write(JSON.stringify({
                productId,
                error: errorMsg,
                details: details
              }));
              
              errors.push({ productId, error: errorMsg, details });
              failCount++;
            }
            
            processedCount++;
            console.log(`Completed ${processedCount}/${productsToProcess.length} products`);
          } catch (error) {
            console.error(`Error processing ${productId}:`, error);
            
            if (!isFirstResult) {
              res.write(',');
            } else {
              isFirstResult = false;
            }
            
            const errorMessage = error.message || 'Unknown error';
            
            res.write(JSON.stringify({
              productId,
              error: 'Failed to scrape product',
              details: errorMessage
            }));
            
            errors.push({ productId, error: 'Failed to scrape product', details: errorMessage });
            failCount++;
            processedCount++;
          }
        });
      })
    );
    
    // Finish the response JSON - added errors array
    res.write(`],"totalProducts":${processedCount},"successfulScrapes":${successCount},"failedScrapes":${failCount},"errors":${JSON.stringify(errors)}}`);
    res.end();
    
    // Clean up uploaded file
    fs.unlink(filePath, (err) => {
      if (err) console.error('Error deleting temp file:', err);
    });
    
  } catch (error) {
    console.error('Error in CSV upload handler:', error);
    // If we haven't started writing the response yet
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: 'Failed to process CSV file',
        details: error.message
      });
    } else {
      // If we've already started writing, try to close the response gracefully
      try {
        res.write(`],"error":"${error.message}","totalProducts":0,"successfulScrapes":0,"failedScrapes":0,"errors":[]}`);
        res.end();
      } catch (finalError) {
        console.error('Failed to close response stream:', finalError);
      }
    }
  }
});

// Add this route for debugging

// Test route to verify the server is working
app.get('/api/test', (req, res) => {
  res.json({
    success: true,
    message: 'API is working correctly',
    timestamp: new Date().toISOString()
  });
});

// Add this route to regenerate the combined JSON file
app.get('/api/regenerate-products-json', async (req, res) => {
  try {
    const filePath = await regenerateCombinedJSON();
    res.json({
      success: true,
      message: 'Products JSON regenerated successfully',
      path: filePath
    });
  } catch (error) {
    console.error('Error regenerating products JSON:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to regenerate products JSON',
      details: error.message
    });
  }
});

// Add this route to handle user state synchronization
app.post('/api/sync-user-state', express.json(), async (req, res) => {
  try {
    const { userId, stateData } = req.body;
    
    if (!userId || !stateData) {
      return res.status(400).json({
        success: false,
        error: 'User ID and state data are required'
      });
    }
    
    // Ensure user-state directory exists
    const userStateDir = path.join(__dirname, 'user-state');
    if (!fs.existsSync(userStateDir)) {
      fs.mkdirSync(userStateDir);
    }
    
    // Path to user state file
    const userStatePath = path.join(userStateDir, `${userId}.json`);
    
    // Save the user state
    fs.writeFileSync(userStatePath, JSON.stringify({
      lastUpdated: Date.now(),
      data: stateData
    }));
    
    res.json({
      success: true,
      message: 'User state saved successfully'
    });
  } catch (error) {
    console.error('Error saving user state:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save user state',
      details: error.message
    });
  }
});

// Add this route to retrieve user state
app.get('/api/user-state/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const userStatePath = path.join(__dirname, 'user-state', `${userId}.json`);
    
    if (fs.existsSync(userStatePath)) {
      const userData = JSON.parse(fs.readFileSync(userStatePath, 'utf8'));
      res.json({
        success: true,
        state: userData
      });
    } else {
      // If no state exists yet, return empty state
      res.json({
        success: true,
        state: {
          lastUpdated: Date.now(),
          data: {}
        }
      });
    }
  } catch (error) {
    console.error('Error retrieving user state:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve user state',
      details: error.message
    });
  }
});

// Add this route for CSV download
app.get('/api/download-products-csv', async (req, res) => {
  try {
    // Read the products.json file
    const productsPath = path.join(__dirname, 'products.json');
    
    if (!fs.existsSync(productsPath)) {
      return res.status(404).json({
        success: false,
        error: 'Products file not found'
      });
    }
    
    const rawData = fs.readFileSync(productsPath, 'utf8');
    const productsData = JSON.parse(rawData);
    const products = productsData.products;
    
    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No products found'
      });
    }
    
    // Create CSV header
    const headers = Object.keys(products[0]).join(',');
    
    // Create CSV rows
    const rows = products.map(product => {
      return Object.values(product).map(value => {
        // Ensure values with commas are properly quoted
        if (typeof value === 'string' && (value.includes(',') || value.includes('"') || value.includes('\n'))) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      }).join(',');
    });
    
    // Combine header and rows
    const csv = [headers, ...rows].join('\n');
    
    // Set response headers for file download
    res.setHeader('Content-Disposition', 'attachment; filename=products.csv');
    res.setHeader('Content-Type', 'text/csv');
    
    // Send the CSV data
    res.send(csv);
  } catch (error) {
    console.error('Error generating CSV:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate CSV',
      details: error.message
    });
  }
});

// Add these routes to support the advanced analysis features

// Route to get price history for a product
app.get('/api/price-history/:productId', (req, res) => {
  const { productId } = req.params;
  const historyPath = path.join(__dirname, 'price-history', `${productId}.json`);
  
  try {
    if (fs.existsSync(historyPath)) {
      const historyData = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      res.json({
        success: true,
        history: historyData
      });
    } else {
      // If no history file exists yet, create an empty one for future use
      const initialData = [];
      
      // Ensure directory exists
      const historyDir = path.join(__dirname, 'price-history');
      if (!fs.existsSync(historyDir)) {
        fs.mkdirSync(historyDir);
      }
      
      fs.writeFileSync(historyPath, JSON.stringify(initialData));
      
      res.json({
        success: true,
        history: initialData
      });
    }
  } catch (error) {
    console.error('Error fetching price history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve price history'
    });
  }
});

// Route for cross-platform price comparison
app.post('/api/compare-prices', async (req, res) => {
  const { productId, searchTerm } = req.body;
  
  if (!productId || !searchTerm) {
    return res.status(400).json({
      success: false,
      error: 'Product ID and search term are required'
    });
  }
  
  try {
    // Get current product data from cache
    const productCachePath = path.join(__dirname, 'cache', `${productId}.json`);
    
    if (!fs.existsSync(productCachePath)) {
      return res.status(404).json({
        success: false,
        error: 'Product not found in cache'
      });
    }
    
    const productData = JSON.parse(fs.readFileSync(productCachePath, 'utf8'));
    
    // Create comparison results (in a real implementation, you would search other platforms)
    // For now, we'll simulate with mock data
    const comparisonResults = [
      {
        platform: 'Myntra',
        price: productData.data.data.price,
        title: productData.data.data.title,
        availability: productData.data.data.availability,
        url: `https://www.myntra.com/products/${productId}`
      },
      // Simulate Amazon result (in production, you'd actually scrape or use an API)
      {
        platform: 'Amazon',
        price: Math.round(parseInt(productData.data.data.price) * (Math.random() * 0.3 + 0.85)), // Random price variation
        title: `${productData.data.data.brand} ${productData.data.data.title.split(' ').slice(0, 4).join(' ')}`,
        availability: Math.random() > 0.3 ? 'in_stock' : 'out_of_stock', // Random availability
        url: `https://www.amazon.in/s?k=${encodeURIComponent(searchTerm)}`
      },
      // Simulate Flipkart result
      {
        platform: 'Flipkart',
        price: Math.round(parseInt(productData.data.data.price) * (Math.random() * 0.3 + 0.85)), // Random price variation
        title: `${productData.data.data.brand} ${productData.data.data.title.split(' ').slice(0, 4).join(' ')}`,
        availability: Math.random() > 0.3 ? 'in_stock' : 'out_of_stock', // Random availability
        url: `https://www.flipkart.com/search?q=${encodeURIComponent(searchTerm)}`
      }
    ];
    
    res.json({
      success: true,
      results: comparisonResults
    });
    
  } catch (error) {
    console.error('Error comparing prices:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to compare prices',
      details: error.message
    });
  }
});

// Modify your existing scrape function to update price history
const originalScrapeMyntraProduct = scrapeMyntraProduct;

// Instead of replacing the original function, create a wrapper function
async function scrapeMyntraProductWithHistory(url) {
  try {
    console.log(`Starting scrape with history tracking for: ${url}`);
    
    // Add timeout to the scraping function itself
    const scrapePromise = originalScrapeMyntraProduct(url);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Internal scraper timeout')), 290000)
    );
    
    const result = await Promise.race([scrapePromise, timeoutPromise]);
    
    if (result && result.success) {
      try {
        // Extract product ID from URL
        const urlSegments = url.split('/');
        const productId = urlSegments[urlSegments.length - 2] || urlSegments[urlSegments.length - 1];
        
        // Ensure price history directory exists
        const historyDir = path.join(__dirname, 'price-history');
        if (!fs.existsSync(historyDir)) {
          fs.mkdirSync(historyDir);
        }
        
        // Path to history file
        const historyPath = path.join(historyDir, `${productId}.json`);
        
        // Read existing history or create new array
        let history = [];
        if (fs.existsSync(historyPath)) {
          history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        }
        
        // Add new price data point
        history.push({
          date: new Date().toISOString(),
          price: result.data.price
        });
        
        // Keep only last 30 data points to prevent file from growing too large
        if (history.length > 30) {
          history = history.slice(history.length - 30);
        }
        
        // Save updated history
        fs.writeFileSync(historyPath, JSON.stringify(history));
        console.log(`Successfully updated price history for product ID: ${productId}`);
        
      } catch (error) {
        console.error('Error updating price history:', error);
        // Don't fail the main scrape if history update fails
      }
    } else if (!result) {
      return {
        success: false,
        error: 'Scraping function returned null or undefined result',
        details: 'Internal server error'
      };
    }
    
    return result;
  } catch (error) {
    console.error('Error in scrapeMyntraProductWithHistory wrapper:', error);
    return {
      success: false,
      error: 'Failed to complete scraping operation',
      details: error.message || 'Unknown error'
    };
  }
}

// Use the wrapper function directly in the routes instead of reassigning
// Update the scraping function references

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to test the scraper`);
});

// Add this cleanup logic at the end of server.js
process.on('SIGINT', async () => {
  console.log('SIGINT received, closing browser and exiting...');
  if (browser) await browser.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing browser and exiting...');
  if (browser) await browser.close();
  process.exit(0);
});

// Add this to server.js
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Add a more comprehensive health check endpoint
app.get('/health', async (req, res) => {
  const memoryUsage = process.memoryUsage();
  const memoryUsageMB = Math.round(memoryUsage.rss / 1024 / 1024);
  
  let browserStatus = 'unknown';
  
  try {
    // Check browser health
    if (browser && browser.process() != null) {
      browserStatus = 'connected';
    } else {
      browserStatus = 'disconnected';
      
      // Try to reinitialize the browser
      console.log('Browser disconnected, attempting to reinitialize...');
      browser = await initBrowser().catch(err => {
        console.error('Failed to reinitialize browser:', err);
        browserStatus = 'failed_to_reinitialize';
      });
      
      if (browser) {
        browserStatus = 'reinitialized';
      }
    }
  } catch (error) {
    console.error('Error checking browser health:', error);
    browserStatus = 'error';
  }
  
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      rss: `${memoryUsageMB}MB`,
      heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`
    },
    browser: browserStatus
  });
});