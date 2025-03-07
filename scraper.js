const puppeteer = require('puppeteer');

// At the top of your scraper.js
const scrapingQueue = [];
let isProcessing = false;
const RATE_LIMIT_DELAY = 2000; // 2 seconds between requests

const productCache = new Map();
const CACHE_TTL = 3600000; // 1 hour in milliseconds

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
  if (!browser) {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1920,1080'
      ],
      defaultViewport: { width: 1920, height: 1080 }
    });
  }
  return browser;
}

let browserPagePool = [];
const MAX_PAGES = 10;

async function getPage() {
  if (browserPagePool.length > 0) {
    return browserPagePool.pop();
  }
  
  const browser = await initBrowser();
  const page = await browser.newPage();
  
  // Set viewport and user agent
  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
  
  // Set request interception
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const resourceType = request.resourceType();
    const url = request.url().toLowerCase();
    
    // Block more resource types and specific domains
    if (resourceType === 'image' || 
        resourceType === 'font' || 
        resourceType === 'media' || 
        resourceType === 'stylesheet' ||
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
  
  return page;
}

function releasePage(page) {
  if (browserPagePool.length < MAX_PAGES) {
    browserPagePool.push(page);
  } else {
    page.close().catch(console.error);
  }
}

// Update the actualScrapeFunction in scraper.js to handle errors more gracefully
function actualScrapeFunction(url) {
  return new Promise(async (resolve, reject) => {
    let page = null;
    try {
      // URL validation - more flexible to allow internal testing with IDs
      if (!url || !(url.includes('myntra.com') || /^\d+$/.test(url))) {
        throw new Error('Invalid Myntra URL or product ID');
      }

      console.log(`Attempting to scrape: ${url}`);
      
      page = await getPage();
      
      // Increase timeout and modify navigation settings
      await page.goto(url, { 
        waitUntil: 'domcontentloaded', // Changed from networkidle2 to make it faster
        timeout: 45000  // Increased from 30000 to 45000
      });

      // Try a more robust approach to wait for content
      try {
        await Promise.race([
          page.waitForSelector('h1, .pdp-name, .pdp-title, .product-title, div[class*="price"]', { timeout: 20000 }),
          page.waitForFunction(() => document.title && document.title !== 'Loading...', { timeout: 20000 }),
          // Wait at least 5 seconds for basic content
          new Promise(resolve => setTimeout(resolve, 5000))
        ]);
      } catch (waitError) {
        console.log('Wait for selector timed out, but continuing anyway');
      }

      // Take a screenshot for debugging purposes
      const screenshotPath = `debug-${url.split('/').pop()}-${Date.now()}.png`;
        ];
        
        for (const selector of clickTargets) {
          const elements = document.querySelectorAll(selector);
          if (elements && elements.length > 0) {
            try {
              elements[0].click();
              console.log("Clicked on:", selector);
            } catch (e) {
              // Click failed, just continue
            }
          }
        }
      });

      // Wait a moment for any updates triggered by the clicks
      await page.waitForTimeout(1000);
      
      // Wait for the main content to load
      await page.waitForSelector('h1, .pdp-name, .pdp-title, .product-title, div[class*="price"]', 
        { timeout: 10000 })
        .catch(() => console.log('Could not find standard product selectors, continuing anyway'));

      // Scroll down to ensure all dynamic content loads
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight / 2);
      });

      // Wait a moment for any lazy-loaded content
      await page.waitForTimeout(1000);

      // Now extract the product data with our enhanced selector logic
      const productData = await page.evaluate(() => {
        const data = {
          title: document.title.replace(' | Myntra', '') || "Unknown Product",
          brand: "Unknown Brand",
          price: "N/A",
          description: "",
          images: []
        };
        
        try {
          // Extract title (multiple approaches)
          const titleSelectors = [
            '.pdp-title h1', 
            '.pdp-name', 
            '.title-container h1',
            'h1.title',
            'h1'
          ];
          
          for (const selector of titleSelectors) {
            const element = document.querySelector(selector);
            if (element && element.textContent.trim()) {
              data.title = element.textContent.trim();
              break;
            }
          }
          
          // Extract brand (multiple approaches)
          const brandSelectors = [
            '.pdp-title .brand-name', 
            '.brand-name',
            '.pdp-product-brand',
            'h1.title + div',
            '.breadcrumbs a:first-child'
          ];
          
          for (const selector of brandSelectors) {
            const element = document.querySelector(selector);
            if (element && element.textContent.trim()) {
              data.brand = element.textContent.trim();
              break;
            }
          }
          
          // Extract price (more precise approaches)
          const priceSelectors = [
            '.pdp-price .selling-price strong',
            '.pdp-price strong',
            '.pdp-price .selling-price',
            'span.pdp-price strong',
            'div.price-disconnect-container span.strike',
            'div.price-disconnect-container span',
            'p.price-container span',
            '.pdp-mrp s',
            '.pdp-price .discount-container',
            'span[class*="discountedPrice"]',
            '.price-value',
            'div[class*="priceWrapper"] span',
            'span[class*="lfloat product-price"]',
            'div[class*="PriceSection"]',
            'span[class*="price"]'
          ];
          
          for (const selector of priceSelectors) {
            const element = document.querySelector(selector);
            if (element && element.textContent.trim()) {
              // Extract only the numbers from price text
              let priceText = element.textContent.trim();
              
              // Check if this is really a price (should contain ₹ or Rs. or similar)
              if (!/[₹₨Rs.]/i.test(priceText) && !/price/i.test(element.parentElement?.className || '')) {
                continue; // Skip this element if it doesn't look like a price
              }
              
              // Extract numbers, handling Indian style pricing (₹1,999)
              let priceMatch = priceText.match(/[₹₨Rs.]*\s*([,\d]+)/i);
              if (priceMatch && priceMatch[1]) {
                // Verify this is likely a price and not a product ID by checking its length
                // Product IDs are typically 8 digits, prices usually less
                const cleanPrice = priceMatch[1].replace(/,/g, '');
                if (cleanPrice.length <= 6) { // Most prices are under 1,000,000
                  data.price = cleanPrice;
                  break;
                }
              }
            }
          }
          
          // If still no price, try a last resort HTML content search
          if (data.price === "N/A") {
            // Add debug output
            console.log("Using last resort price extraction");
            
            // Try to identify price sections more intelligently
            const potentialPriceContainers = document.querySelectorAll('div[class*="price"], span[class*="price"], p[class*="price"]');
            for (const container of potentialPriceContainers) {
              const text = container.textContent.trim();
              // Only consider texts that have currency symbols and don't look like product IDs
              if ((/[₹₨Rs.]/i.test(text) || /^\s*\d{2,4}\s*$/.test(text)) && !/^\d{8,}$/.test(text)) {
                const matches = text.match(/[\d,]+/g);
                if (matches && matches.length > 0) {
                  // Get the first number that seems like a reasonable price (not too long)
                  for (const match of matches) {
                    const cleanPrice = match.replace(/,/g, '');
                    if (cleanPrice.length <= 6) {
                      data.price = cleanPrice;
                      break;
                    }
                  }
                  if (data.price !== "N/A") break;
                }
              }
            }
          }
          
          // Add debugging output
          if (data.price === "N/A") {
            // Log all potential numeric content for debugging
            const allNumericTexts = [];
            document.querySelectorAll('*').forEach(el => {
              if (el.textContent && /\d/.test(el.textContent) && el.textContent.trim().length < 20) {
                const text = el.textContent.trim();
                allNumericTexts.push({
                  text: text,
                  tag: el.tagName,
                  class: el.className
                });
              }
            });
            
            // Try extracting from structured data as a last resort
            const structuredDataElements = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of structuredDataElements) {
              try {
                const jsonData = JSON.parse(script.textContent);
                if (jsonData.offers && jsonData.offers.price) {
                  data.price = jsonData.offers.price.toString();
                  break;
                } else if (jsonData.price) {
                  data.price = jsonData.price.toString();
                  break;
                }
              } catch (e) {
                // JSON parsing failed, continue
              }
            }
          }
          
          // Extract product description
          const descriptionSelectors = [
            '.pdp-product-description',
            '.description',
            'div[class*="description"]'
          ];
          
          for (const selector of descriptionSelectors) {
            const element = document.querySelector(selector);
            if (element && element.textContent.trim()) {
              data.description = element.textContent.trim();
              break;
            }
          }
          
          // Try to extract structured data if available (often has complete product info)
          const structuredDataElements = document.querySelectorAll('script[type="application/ld+json"]');
          for (const script of structuredDataElements) {
            try {
              const jsonData = JSON.parse(script.textContent);
              
              // Product schema
              if (jsonData['@type'] === 'Product') {
                if (!data.title || data.title === "Unknown Product") data.title = jsonData.name;
                
                if (!data.brand || data.brand === "Unknown Brand") {
                  if (jsonData.brand && jsonData.brand.name) {
                    data.brand = jsonData.brand.name;
                  } else if (typeof jsonData.brand === "string") {
                    data.brand = jsonData.brand;
                  }
                }
                
                if (!data.description) data.description = jsonData.description;
                
                if (data.price === "N/A" && jsonData.offers && jsonData.offers.price) {
                  data.price = jsonData.offers.price;
                }
                
                if (jsonData.image) {
                  data.images = Array.isArray(jsonData.image) ? jsonData.image : [jsonData.image];
                }
              }
            } catch (e) {
              // JSON parsing failed, continue
            }
          }
          
          // Try a last-resort approach to extract info from the page title
          if (data.title === "Unknown Product" || data.brand === "Unknown Brand") {
            const pageTitle = document.title;
            const titleParts = pageTitle.split(' - ')[0].split(' ');
            
            if (titleParts.length > 1 && data.brand === "Unknown Brand") {
              data.brand = titleParts[0];
            }
            
            if (data.title === "Unknown Product") {
              data.title = pageTitle.replace(' | Myntra', '');
            }
          }
          
        } catch (e) {
          console.error('Error extracting product data:', e);
        }
        
        return data;
      });
      
      // We won't throw an error if title is missing, just use default
      console.log('Successfully scraped product data');
      
      resolve({
        success: true,
        data: productData
      });
    } catch (error) {
      console.error('Error scraping Myntra:', error.message);
      
      // Return an error response instead of rejecting
      resolve({
        success: false,
        error: 'Failed to scrape product data',
        details: error.message || 'Unknown error'
      });
    } finally {
      if (page) releasePage(page);
    }
  });
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
        }
        resolve(result);
      })
      .catch(reject);
  });
}

module.exports = scrapeMyntraProduct;