const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Add to the top of scraper.js
const browserPool = [];
const MAX_BROWSERS = 5;

async function getOrCreateBrowser() {
  if (browserPool.length > 0) {
    return browserPool.pop();
  }
  
  return await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox',
      // ...existing args
    ]
  });
}

// At the top of your scraper.js
const scrapingQueue = [];
let isProcessing = false;
const RATE_LIMIT_DELAY = 200; // 2 seconds between requests

const productCache = new Map();
const CACHE_TTL = 604800000; // 1 hour in milliseconds

async function processQueue() {
  if (isProcessing || scrapingQueue.length === 0) return;
  
  isProcessing = true;
  const { url, resolve, reject } = scrapingQueue.shift();
  
  console.log(`Processing queue item: ${url}`);
  
  try {
    const result = await actualScrapeFunction(url);
    resolve(result);
  } catch (error) {
    console.error('Error in processQueue:', error);
    reject(error);
  } finally {
    isProcessing = false;
    
    // Continue processing queue after a delay
    if (scrapingQueue.length > 0) {
      console.log(`Queue has ${scrapingQueue.length} remaining items. Processing next after delay.`);
      setTimeout(processQueue, RATE_LIMIT_DELAY);
    } else {
      console.log('Queue processing complete.');
    }
  }
}

// Create a browser instance once
let browser;

async function initBrowser() {
  if (browser && browser.process() != null) {
    try {
      return browser;
    } catch (e) {
      console.log('Existing browser disconnected, launching new instance');
    }
  }
  
  try {
    console.log('Launching new browser instance with optimized settings for containerized environment');
    browser = await puppeteer.launch({
      headless: "new", // Use new headless mode for better performance
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
      timeout: 0 // Disable Puppeteer's own timeout
    });
    
    // Handle browser disconnection
    browser.on('disconnected', () => {
      console.log('Browser disconnected. Will create a new instance on next request.');
      browser = null;
    });
    
    return browser;
  } catch (error) {
    console.error('Failed to launch browser:', error);
    throw error;
  }
}

let browserPagePool = [];
const MAX_PAGES = 5;

async function getPage() {
  if (browserPagePool.length > 0) {
    const page = browserPagePool.pop();
    try {
      // Test if page is still usable
      await page.evaluate(() => true);
      return page;
    } catch (e) {
      console.log('Cached page no longer usable, creating new one');
    }
  }
  
  // Get or create browser instance
  const browserInstance = await initBrowser();
  const page = await browserInstance.newPage();
  
  // Set page timeout to 0 (no timeout)
  page.setDefaultTimeout(0);
  
  // Set viewport and user agent
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.99 Safari/537.36');
  
  // Configure request interception for better performance
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const resourceType = request.resourceType();
    const url = request.url().toLowerCase();
    
    // Block unnecessary resources to improve performance
    if (resourceType === 'image' || 
        resourceType === 'font' || 
        resourceType === 'stylesheet' ||
        resourceType === 'media' ||
        url.includes('google-analytics') ||
        url.includes('facebook') ||
        url.includes('analytics') ||
        url.includes('tracker') ||
        url.includes('advertisement')) {
      request.abort();
    } else {
      request.continue();
    }
  });

  // Add error handlers
  page.on('error', err => {
    console.error('Page error:', err);
  });

  page.on('pageerror', err => {
    console.error('Page error in browser context:', err);
  });
  
  return page;
}

function releasePage(page) {
  if (browserPagePool.length < MAX_PAGES) {
    browserPagePool.push(page);
  } else {
    page.close().catch(console.error);
  }
}

// Add to your scraper.js
function saveToFileCache(productId, data) {
  const cacheDir = path.join(__dirname, 'cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir);
  }
  
  // Save individual product cache
  fs.writeFileSync(
    path.join(cacheDir, `${productId}.json`), 
    JSON.stringify({timestamp: Date.now(), data})
  );
  
  // Regenerate the combined JSON after adding a new product
  generateCombinedProductsJSON();
}

// Add this function to generate a combined products JSON file

function generateCombinedProductsJSON() {
  const cacheDir = path.join(__dirname, 'cache');
  const combinedPath = path.join(__dirname, 'products.json');
  const allProducts = [];
  
  // Check if cache directory exists
  if (!fs.existsSync(cacheDir)) {
    console.log('Cache directory does not exist, creating it.');
    fs.mkdirSync(cacheDir);
    return; // No files to process
  }
  
  try {
    // Read all JSON files in the cache directory
    const files = fs.readdirSync(cacheDir).filter(file => file.endsWith('.json'));
    
    if (files.length === 0) {
      console.log('No product cache files found.');
      return;
    }
    
    console.log(`Found ${files.length} product files in cache.`);
    
    // Process each file and build the combined data
    for (const file of files) {
      try {
        const filePath = path.join(cacheDir, file);
        const rawData = fs.readFileSync(filePath, 'utf8');
        const productData = JSON.parse(rawData);
        
        // Extract product ID from filename (remove .json extension)
        const productId = path.basename(file, '.json');
        
        // Add to the array as a flat object (better for CSV conversion)
        allProducts.push({
          id: productId,
          lastUpdated: productData.timestamp,
          title: productData.data.data.title || '',
          brand: productData.data.data.brand || '',
          price: productData.data.data.price || '',
          availability: productData.data.data.availability || '',
          description: productData.data.data.description || '',
          images: (productData.data.data.images || []).join(','),
          availableSizes: (productData.data.data.availableSizes || []).join(',')
        });
      } catch (err) {
        console.error(`Error processing file ${file}:`, err);
      }
    }
    
    // Save the combined data
    fs.writeFileSync(
      combinedPath, 
      JSON.stringify({
        lastGenerated: Date.now(),
        productCount: allProducts.length,
        products: allProducts
      }, null, 2) // Add indentation for readability
    );
    
    console.log(`Successfully generated combined products JSON with ${allProducts.length} products.`);
    return combinedPath;
  } catch (err) {
    console.error('Error generating combined products JSON:', err);
  }
}

// Add an endpoint to manually regenerate the combined JSON
// This can be called via API rather than regenerating on every save
async function regenerateCombinedJSON() {
  return generateCombinedProductsJSON();
}

// Update the actualScrapeFunction in scraper.js to handle errors more gracefully
function actualScrapeFunction(url) {
  return new Promise(async (resolve, reject) => {
    let page = null;
    let retries = 3; // Add retry mechanism
    
    while (retries > 0) {
      try {
        console.log(`Attempting to scrape (retry ${4-retries}/3): ${url}`);
        
        page = await getPage();

        // Set a timeout for navigation
        const navigationPromise = page.goto(url, { 
          waitUntil: 'domcontentloaded',
          timeout: 60000  // 60 second timeout just for navigation
        });

        // Create a timeout safety net
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Navigation timeout exceeded')), 60000)
        );

        // Race the navigation against our own timeout
        await Promise.race([navigationPromise, timeoutPromise]);
        
        // Wait for some content to be present (with a 20 second max wait)
        try {
          await Promise.race([
            page.waitForSelector('h1, .pdp-name, .pdp-title, .product-title, div[class*="price"]', { timeout: 20000 }),
            new Promise(resolve => setTimeout(resolve, 20000)) // Fallback if selector not found
          ]);
        } catch (waitError) {
          console.log('Wait for selector timed out, but continuing anyway');
        }

        // Scroll down to ensure all dynamic content loads
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight / 3);
          setTimeout(() => window.scrollTo(0, document.body.scrollHeight * 2/3), 500);
          setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 1000);
        });

        // Extract the product data
        const productData = await page.evaluate(() => {
          // Your existing data extraction logic...
          const data = {
            title: document.title.replace(' | Myntra', '') || "Unknown Product",
            brand: "Unknown Brand",
            price: "N/A",
            description: "",
            images: [],
            availability: "unknown" 
          };
          
          // The rest of your extraction code...
          return data;
        });
        
        console.log('Successfully scraped product data');
        
        // Release the page back to the pool
        if (page) releasePage(page);
        
        // Return success
        resolve({
          success: true,
          data: productData
        });
        
        // Exit retry loop on success
        break;
      } catch (error) {
        console.error(`Error scraping attempt ${4-retries}/3:`, error.message);
        
        // Release the page on error
        if (page) {
          try {
            await page.close().catch(() => {});
          } catch (e) {
            console.error('Error closing page:', e);
          }
        }
        
        retries--;
        
        // If we have retries left, wait before trying again
        if (retries > 0) {
          console.log(`Retrying in 3 seconds... (${retries} attempts left)`);
          await new Promise(resolve => setTimeout(resolve, 3000));
        } else {
          // All retries failed, return error response
          resolve({
            success: false,
            error: 'Failed to scrape product data after multiple attempts',
            details: error.message || 'Unknown error'
          });
        }
      }
    }
  });
}

// Replace your existing checkAvailability function with this improved version

function checkAvailability() {
  try {
    // FIRST CHECK: Look for the ADD TO BAG div element pattern specific to Myntra
    // This is the most reliable indicator a product is in stock
    const addToBagElements = document.querySelectorAll('.pdp-add-to-bag:not(.pdp-out-of-stock)');
    if (addToBagElements && addToBagElements.length > 0) {
      console.log("Found ADD TO BAG element - product is in stock");
      return 'in_stock';
    }
    
    // SECOND CHECK: Check for specific out-of-stock indicators used by Myntra
    const outOfStockElements = document.querySelectorAll('.size-buttons-out-of-stock, .pdp-out-of-stock, .soldOutP');
    if (outOfStockElements && outOfStockElements.length > 0) {
      console.log("Found out of stock indicator elements");
      return 'out_of_stock';
    }
    
    // THIRD CHECK: Check text content for "out of stock" phrases
    // Use parentElement check to target only text directly in these elements
    const stockStatusElements = document.querySelectorAll('.pdp-add-to-bag, .pdp-action-container, .size-buttons-container');
    for (const element of stockStatusElements) {
      if (element.textContent.toLowerCase().includes('out of stock') || 
          element.textContent.toLowerCase().includes('sold out')) {
        console.log("Found 'out of stock' text in relevant element");
        return 'out_of_stock';
      }
    }
    
    // FOURTH CHECK: Check if all size buttons are marked as out of stock
    const sizeElements = document.querySelectorAll('.size-buttons-unified-size');
    if (sizeElements && sizeElements.length > 0) {
      const allSizesOutOfStock = Array.from(sizeElements).every(el => 
        el.classList.contains('size-buttons-unified-size-out-of-stock') || 
        el.classList.contains('size-buttons-unified-size-strike-hide')
      );
      
      if (allSizesOutOfStock) {
        console.log("All size buttons are marked as out of stock");
        return 'out_of_stock';
      } else {
        console.log("Found available sizes - product is in stock");
        return 'in_stock';
      }
    }
    
    // FIFTH CHECK: Final check for any ADD TO BAG text in relevant containers
    const anyBagText = document.body.textContent.includes('ADD TO BAG');
    if (anyBagText && !document.body.textContent.includes('OUT OF STOCK')) {
      console.log("Found ADD TO BAG text without OUT OF STOCK text");
      return 'in_stock';
    }
    
    // Default to in_stock for Myntra (as they typically don't show unavailable products)
    console.log("No definitive indicators found, defaulting to in_stock");
    return 'in_stock';
  } catch (e) {
    console.error('Error checking availability:', e);
    return 'in_stock'; // Default to in_stock on error
  }
}

// Update the scrapeMyntraProduct function in scraper.js
async function scrapeMyntraProduct(url) {
  // Check if the input is just an ID number
  if (/^\d+$/.test(url)) {
    // Convert numeric ID to a proper Myntra URL format
    // Try both formats since we don't know which is correct
    console.log(`Received numeric ID: ${url}, converting to URL`);
    
    // For format /product-name/brand/product-id
    url = `https://www.myntra.com/products/${url}`;
  } else if (!url.startsWith('http')) {
    // If URL doesn't start with http, assume it's a path and prepend Myntra domain
    url = `https://www.myntra.com/${url}`;
  }
  
  console.log(`Final URL being processed: ${url}`);
  
  // Extract product ID from URL (last segment)
  const urlSegments = url.split('/');
  const productId = urlSegments[urlSegments.length - 1];
  
  // Check if in cache and not expired
  if (productCache.has(productId)) {
    const cachedData = productCache.get(productId);
    if (Date.now() - cachedData.timestamp < CACHE_TTL) {
      console.log(`Returning cached data for product ${productId}`);
      return Promise.resolve(cachedData.data);
    }
  }
  
  // If not in cache or expired, scrape and then cache
  return new Promise((resolve, reject) => {
    actualScrapeFunction(url)
      .then(result => {
        if (result.success) {
          productCache.set(productId, {
            timestamp: Date.now(),
            data: result
          });
          saveToFileCache(productId, result);
        }
        resolve(result);
      })
      .catch(reject);
  });
}

// Add Amazon scraping implementation
async function scrapeAmazonProduct(url) {
  console.log(`Scraping Amazon product: ${url}`);
  
  // Extract ASIN from URL if needed
  let productId = 'unknown';
  const asinMatch = url.match(/\/dp\/([A-Z0-9]{10})/);
  if (asinMatch) {
    productId = asinMatch[1];
  }
  
  // Check cache like the Myntra implementation
  if (productCache.has(productId)) {
    const cachedData = productCache.get(productId);
    if (Date.now() - cachedData.timestamp < CACHE_TTL) {
      console.log(`Returning cached data for Amazon product ${productId}`);
      return Promise.resolve(cachedData.data);
    }
  }
  
  // Similar pattern to scrapeMyntraProduct
  return new Promise((resolve, reject) => {
    actualScrapeAmazonFunction(url)
      .then(result => {
        if (result.success) {
          productCache.set(productId, {
            timestamp: Date.now(),
            data: result
          });
          saveToFileCache(productId, result);
        }
        resolve(result);
      })
      .catch(reject);
  });
}

// Amazon scraping implementation
function actualScrapeAmazonFunction(url) {
  return new Promise(async (resolve, reject) => {
    let page = null;
    
    try {
      page = await getPage();
      
      // Set user agent to avoid bot detection
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
      
      console.log(`Navigating to Amazon URL: ${url}`);
      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      
      if (!response || response.status() !== 200) {
        throw new Error(`Failed to load Amazon page: ${response ? response.status() : 'No response'}`);
      }
      
      // Check for CAPTCHA page
      const pageTitle = await page.title();
      if (pageTitle.includes('Robot') || pageTitle.includes('CAPTCHA')) {
        throw new Error('Amazon bot protection detected. Please try again later.');
      }
      
      // Extract product data
      const productData = await page.evaluate(() => {
        const data = {
          title: document.querySelector('#productTitle')?.textContent.trim() || 'Unknown Product',
          brand: document.querySelector('#bylineInfo')?.textContent.trim() || 'Unknown Brand',
          price: document.querySelector('.a-price .a-offscreen')?.textContent.trim() || 'N/A',
          description: document.querySelector('#productDescription')?.textContent.trim() || 
                       document.querySelector('#feature-bullets')?.textContent.trim() || '',
          images: [],
          availableSizes: []
        };
        
        // Get all image URLs
        const imageElements = document.querySelectorAll('#altImages img');
        if (imageElements && imageElements.length > 0) {
          data.images = Array.from(imageElements)
            .map(img => {
              const src = img.dataset.oldHires || img.src;
              return src.replace(/._[^.]+\./, '.'); // Convert to full-size image
            })
            .filter(url => url && !url.includes('spinner') && !url.includes('play-button'));
        }
        
        // Get main image if altImages is empty
        if (data.images.length === 0) {
          const mainImage = document.querySelector('#landingImage, #imgBlkFront');
          if (mainImage) {
            const src = mainImage.dataset.oldHires || mainImage.src;
            data.images.push(src);
          }
        }
        
        // Check availability
        const availabilityText = document.querySelector('#availability')?.textContent.trim() || '';
        data.availability = availabilityText.toLowerCase().includes('in stock') ? 'in_stock' : 'out_of_stock';
        
        // Extract sizes if available (for clothing items)
        const sizeElements = document.querySelectorAll('#variation_size_name .a-size-base:not(.a-color-secondary)');
        if (sizeElements && sizeElements.length > 0) {
          data.availableSizes = Array.from(sizeElements)
            .map(el => el.textContent.trim())
            .filter(size => size);
        }
        
        return data;
      });
      
      console.log('Successfully scraped Amazon product data');
      
      resolve({
        success: true,
        data: productData
      });
    } catch (error) {
      console.error('Error scraping Amazon:', error.message);
      
      resolve({
        success: false,
        error: 'Failed to scrape Amazon product data',
        details: error.message || 'Unknown error'
      });
    } finally {
      if (page) releasePage(page);
    }
  });
}

// Add Flipkart scraping implementation
async function scrapeFlipkartProduct(url) {
  console.log(`Scraping Flipkart product: ${url}`);
  
  // Extract product ID from URL
  let productId = 'unknown';
  const pidMatch = url.match(/pid=([^&]+)/);
  if (pidMatch) {
    productId = pidMatch[1];
  } else {
    // Alternative pattern
    const altMatch = url.match(/\/p\/([^/]+)/);
    if (altMatch) {
      productId = altMatch[1];
    }
  }
  
  // Check cache like the Myntra implementation
  if (productCache.has(productId)) {
    const cachedData = productCache.get(productId);
    if (Date.now() - cachedData.timestamp < CACHE_TTL) {
      console.log(`Returning cached data for Flipkart product ${productId}`);
      return Promise.resolve(cachedData.data);
    }
  }
  
  // Similar pattern to scrapeMyntraProduct
  return new Promise((resolve, reject) => {
    actualScrapeFlipkartFunction(url)
      .then(result => {
        if (result.success) {
          productCache.set(productId, {
            timestamp: Date.now(),
            data: result
          });
          saveToFileCache(productId, result);
        }
        resolve(result);
      })
      .catch(reject);
  });
}

// Flipkart scraping implementation
function actualScrapeFlipkartFunction(url) {
  return new Promise(async (resolve, reject) => {
    let page = null;
    
    try {
      page = await getPage();
      
      console.log(`Navigating to Flipkart URL: ${url}`);
      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      
      if (!response || response.status() !== 200) {
        throw new Error(`Failed to load Flipkart page: ${response ? response.status() : 'No response'}`);
      }
      
      // Extract product data
      const productData = await page.evaluate(() => {
        const data = {
          title: document.querySelector('h1.yhB1nd')?.textContent.trim() || 
                 document.querySelector('h1.B_NuCI')?.textContent.trim() || 'Unknown Product',
          brand: document.querySelector('span.G6XhRU')?.textContent.trim() || 'Unknown Brand',
          price: document.querySelector('._30jeq3')?.textContent.trim() || 'N/A',
          description: document.querySelector('._1mXcCf')?.textContent.trim() || '',
          images: [],
          availableSizes: []
        };
        
        // Get all image URLs
        const imageElements = document.querySelectorAll('._2amPTt img, .CXW8mj img, ._3nMexc img');
        if (imageElements && imageElements.length > 0) {
          data.images = Array.from(imageElements)
            .map(img => img.src)
            .filter(url => url && url.includes('flipkart') && !url.includes('placeholder'));
        }
        
        // Check availability
        const outOfStock = document.querySelector('._16FRp0');
        data.availability = outOfStock ? 'out_of_stock' : 'in_stock';
        
        // Extract sizes if available (for clothing items)
        const sizeElements = document.querySelectorAll('._1fGeJ5._2UVyXR._31hAvz');
        if (sizeElements && sizeElements.length > 0) {
          data.availableSizes = Array.from(sizeElements)
            .map(el => el.textContent.trim())
            .filter(size => size);
        }
        
        return data;
      });
      
      console.log('Successfully scraped Flipkart product data');
      
      resolve({
        success: true,
        data: productData
      });
    } catch (error) {
      console.error('Error scraping Flipkart:', error.message);
      
      resolve({
        success: false,
        error: 'Failed to scrape Flipkart product data',
        details: error.message || 'Unknown error'
      });
    } finally {
      if (page) releasePage(page);
    }
  });
}

// Update the exports
module.exports = {
  scrapeMyntraProduct,
  scrapeAmazonProduct,
  scrapeFlipkartProduct,
  regenerateCombinedJSON
};

// Add to server.js
// Memory monitoring
setInterval(() => {
  const memUsage = process.memoryUsage();
  console.log(`Memory usage: ${Math.round(memUsage.rss / 1024 / 1024)}MB`);
}, 60000);