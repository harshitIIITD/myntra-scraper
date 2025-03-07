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
    
    // Race against timeout
    const result = await Promise.race([
      scrapeMyntraProduct(url),
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

// Update the POST API endpoint for scraping
app.post('/api/scrape', async (req, res) => {
  const { url, website = 'myntra' } = req.body;
  
  if (!url) {
    return res.status(400).json({ 
      success: false, 
      error: 'URL parameter is required' 
    });
  }

  try {
    console.log(`Received POST request to scrape ${website} URL: ${url}`);
    
    // Add timeout to see if request is hanging
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Request timeout after 60s')), 60000)
    );
    
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
        scrapingFunction = scrapeMyntraProduct;
    }
    
    // Race against timeout
    const result = await Promise.race([
      scrapingFunction(url),
      timeoutPromise
    ]);
    
    return res.json(result);
  } catch (error) {
    console.error('Error in API endpoint:', error);
    return res.status(500).json({
      success: false,
      error: 'Server error while scraping',
      details: error.message
    });
  }
});

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
      scrapingFunction = scrapeMyntraProduct;
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
    const MAX_PRODUCTS_TO_PROCESS = 100;
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

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to test the scraper`);
});