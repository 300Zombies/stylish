/*** requires  test***/
const express = require("express");
const path = require("path");
const app = express();
const mysql = require("mysql");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const crypto = require("crypto");
const request = require("request");
const NodeCache = require("node-cache");
const myCache = new NodeCache({ // if there are routers, put node-cache as a module and import it.
    stdTTL: 1000, // every key expires in approximately 17 minutes.
    checkperiod: 1200, // check keys every 20 minutes to see if they are expired and gets auto deleted.
});
const AWS = require("aws-sdk");
// const s3 = new AWS.S3();
const multerS3 = require("multer-s3");
// use storage obj see below
const port = 3000;
const pool = mysql.createPool({
    connectionLimit: 10,
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PWD,
    database: process.env.DB_NAME,
    acquireTimeout: 10000,
    waitForConnections: true,
    queueLimit: 10000,
});
/*** middlewares ***/
/*** body-parser important note ***/
app.use(bodyParser.urlencoded({ // urlencoded is <form>'s default data type
    extended: false
}));
app.use(bodyParser.json()); // now body-parser can parse <form>'s json
/*** body-parser important note ***/

app.use(cookieParser());
app.use(express.static('public'));
app.use(express.static('html'));
// app.use('/static', express.static('public')); // here /static means route
// app.use('/admin', express.static('public')); // /public will be root

/*** templates ***/
app.set("view engine", "pug");

/*** routes ***/
app.get("/admin/product.html", (req, res) => { // admin for product
    res.render("product");
});

app.get("/campaign.html", (req, res) => {
    res.render("campaign");
});

app.get("/user/signup", (req, res) => {
    res.render("signup");
});

app.get("/user/signin", (req, res) => {
    res.render("signin");
});

// config multer upload.fields()
const fields = [{
    name: "mainImage",
    maxCount: 1
}, {
    name: "images", // images for addproduct
    maxCount: 3
}];

// config multer storage api
// const storage = multer.diskStorage({
//     destination: function (req, file, cb) {
//         cb(null, "./public/uploads");
//     },
//     filename: function (req, file, cb) {
//         cb(null, `${file.originalname.slice(0, -4)}-${Date.now()}${file.originalname.slice(-4)}`);
//     }
// });

AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
});
const s3 = new AWS.S3();
const upload = multer({
    storage: multerS3({
        s3: s3,
        bucket: "300zombiesbucket/images",
        metadata: function (req, file, cb) {
            cb(null, {
                fieldName: file.fieldname
            });
        },
        key: function (req, file, cb) {
            cb(null, `${file.originalname.slice(0, -4)}-${Date.now()}${file.originalname.slice(-4)}`)
        }
    })
});
/*** INSERT INTO product text/files (product title can't have duplicates) ***/
app.post("/admin/addproduct", upload.fields(fields), async (req, res) => {
    const productData = {
        title: req.body.title,
        category: req.body.category,
        description: req.body.description,
        price: req.body.price,
        texture: req.body.texture,
        wash: req.body.wash,
        place: req.body.place,
        note: req.body.note,
        story: req.body.story,
        main_image: convertFilePath(req.files.mainImage[0].location), // multerS3
        // main_image: convertFilePath(req.files.mainImage[0].filename),
    }
    const variantsData = {
        title: req.body.title,
        color_code: req.body.colorCode,
        color_name: req.body.colorName,
        size: req.body.size,
        stock: req.body.stock,
    }
    const images = req.files.images;
    let imagePaths = bucketImg(images);
    const imageData = {
        title: req.body.title,
        image_path: imagePaths
    }
    const insertImages = "INSERT INTO images SET ?"
    const insertVariants = "INSERT INTO variants SET ?"
    const insertProduct = "INSERT INTO product SET ?"; // OMG the quotes are traps!! use single quotes (e.g.'${var}') when INSERT INTO!!
    let checkProduct = await sqlQuery(`SELECT COUNT(*) FROM product WHERE title = '${productData.title};'`); // TODO: check product title
    checkProduct = checkProduct[0]["COUNT(*)"];
    if (checkProduct === 0) {
        let addProduct = await sqlQuery(insertProduct, productData);
        let addVariants = await sqlQuery(insertVariants, variantsData);
        let addImages = await sqlQuery(insertImages, imageData);
        res.redirect("/");
    } else if (checkProduct === 1) {
        // don't insert product table, insert variants table and update images table instead
        let addVariants = await sqlQuery(insertVariants, variantsData);
        let addImages = await sqlQuery(`UPDATE images SET ?`, imageData);
        res.redirect("/");
    } else {
        console.log("there's duplicates in product table"); // this is very bad
        res.redirect("/");
    }
});

app.post("/admin/addcampaign", upload.fields(fields), async (req, res) => {
    // query first to check how many product and their IDs.
    const campaignIds = await sqlQuery(`SELECT id from product;`);
    let idArray = [];
    for (let i = 0; i < campaignIds.length; i++) {
        idArray.push(campaignIds[i].id);
    }
    const productId = req.body.productId;
    const story = req.body.story;
    const main_image = convertFilePath(req.files.mainImage[0].filename);
    const images = req.files.images;
    let imagePaths = processImages(images);

    if (idArray.includes(parseInt(productId))) {
        let productUpdate = await sqlQuery(`UPDATE product SET story = '${story}', main_image = '${main_image}' WHERE id = '${productId}';`);
        let imagesUpdate = await sqlQuery(`UPDATE images SET image_path = '${imagePaths}' WHERE insert_id = '${productId}';`);
        res.send("campaign updated");
        // clear cache
        myCache.del("allCampaigns", (err, count) => {
            if (!err) {
                console.log("due to db update, allCampaigns cache has been cleared");
            }
        });
        // update cache: leave it to get route
    } else {
        res.send(`product id ${productId} does't exist`);
    }
});

/*** api for marketing ***/
app.get("/api/1.0/marketing/:url", async (req, res) => {
    const url = req.params.url;
    if (url === "campaign") {
        // get campaign data from cache
        let cacheCampaigns = myCache.get("allCampaigns", (err, value) => { // !
            if (!err) {
                return value
            } else {
                console.log(err);
            }
        });
        if (cacheCampaigns == undefined) {
            // got no data, query data from db
            let campaigns = await sqlQuery(`SELECT id, story, main_image FROM product WHERE story != '' OR main_image != '';`);
            imagesArray = await sqlQuery(`select image_path from images where image_path != '';`);
            // check if nextpage
            nextPage = await sqlQuery(`SELECT story, main_image FROM product WHERE story != '' OR main_image != '';`)
            // construct dataArray
            let obj = {};
            let allCampaigns = [];
            for (let i = 0; i < campaigns.length; i++) {
                obj = {
                    id: campaigns[i].id,
                    main_image: campaigns[i].main_image,
                    story: campaigns[i].story,
                }
                allCampaigns.push(obj);
            }
            //  update cache
            console.log("update cache");
            myCache.set("allCampaigns", allCampaigns, (err, success) => {
                if (!err && success) {
                    console.log(`set cache allCampaign success = ${success}`);
                } else {
                    console.log(err);
                    console.log("set cache campaigns fail")
                }
            });
            console.log("got data from db");
            res.send(allCampaigns);
        } else {
            console.log("got data from cache");
            res.send(cacheCampaigns);
        }
    }
});
// user sign up note
// enter email password store in db (best practice: hash password)
// check if email unique
// generate token (module)
// when token generate define expire time (time now + time)
// put token and expire time in db
// user sign in (every sing refreshes token)
// check auth if token expired
// pass it through header

// account provider fb or other
// check fb token no need in db

app.get("/api/1.0/products/allproduct", async (req, res) => { // ! procuct table can't have duplicates
    let allProduct;
    let variantArray = [];
    let sizeArray = [];
    // let imagesArray;
    let colorArray = [];
    let result = {
        data: []
    }
    allProduct = await sqlQuery(`SELECT * FROM product;`);
    // imagesArray = await sqlQuery(`SELECT image_path FROM images;`);
    // console.log(imagesArray[0].image_path)
    for (let i = 0; i < allProduct.length; i++) {
        let variants = await sqlQuery(`SELECT color_code, size ,stock FROM variants WHERE title = '${allProduct[i].title}';`);
        let vSizeArr = [];
        for (let j = 0; j < variants.length; j++) {
            vSizeArr.push(variants[j].size);
        }
        variantArray.push(variants);
        sizeArray.push(vSizeArr);
        let colors = await sqlQuery(`SELECT color_code, color_name FROM variants WHERE title = '${allProduct[i].title}';`);
        let vColorArr = [];
        for (let k = 0; k < colors.length; k++) {
            vColorArr.push(colors[k]);
        }
        colorArray.push(vColorArr);
        let imagesArray = await sqlQuery(`SELECT image_path FROM images WHERE title = '${allProduct[i].title}';`)
        obj = {
            id: allProduct[i].id,
            title: allProduct[i].title,
            description: allProduct[i].description,
            price: allProduct[i].price,
            texture: allProduct[i].texture,
            wash: allProduct[i].wash,
            place: allProduct[i].place,
            note: allProduct[i].note,
            story: allProduct[i].story,
            colors: colorArray[i],
            sizes: sizeArray[i],
            variants: variantArray[i],
            main_image: allProduct[i].main_image,
            images: imagesArray, // DONE: S3 modified
        }
        // console.log(imagesArray[i].image_path)
        result.data.push(obj);
    }
    res.send(result);
});

/*** was category-only api with paging ***/
app.get("/api/1.0/products/:url", async (req, res) => {
    /*** variables ***/
    const url = req.params.url;
    let paging = req.query.paging;
    let keyword = req.query.keyword;
    let colorArray = [];
    let sizeArray = [];
    let variantArray = [];
    let imagesArray;
    let obj;
    let allProduct;
    let result = {
        data: []
    };
    let dataPerPage = 2; // set 2 data per page
    let dataCount;
    let pageCount
    let nextPage
    let searchCount;
    let id = req.query.id;
    if (url === "all") {
        // caculate total number of data and pages
        dataCount = await sqlQuery(`SELECT COUNT(*) FROM product;`);
        dataCount = dataCount[0]["COUNT(*)"];
        pageCount = dataCount % dataPerPage === 0 ? (dataCount / dataPerPage) : (dataCount / dataPerPage) + 1
        // get paging params
        if (isNaN(paging)) {
            paging = 0;
        } else if (!isNaN(paging) && paging < pageCount) {
            paging = parseInt(paging);
        }
        // 2 data per query
        allProduct = await sqlQuery(`SELECT * FROM product LIMIT ${dataPerPage} OFFSET ${(paging) * dataPerPage};`);
        imagesArray = await sqlQuery(`SELECT image_path FROM images LIMIT ${dataPerPage} OFFSET ${(paging) * dataPerPage};`);
        // check next page array length
        nextPage = await sqlQuery(`SELECT * FROM product LIMIT ${dataPerPage} OFFSET ${(paging + 1) * dataPerPage};`);
        // No paging insert if it's last page
        if (nextPage.length === 0) {
            for (let i = 0; i < allProduct.length; i++) { // allProducr.length != dataPerPage
                let variants = await sqlQuery(`SELECT color_code, size ,stock FROM variants WHERE title = '${allProduct[i].title}';`);
                let vSizeArr = [];
                for (let j = 0; j < variants.length; j++) {
                    vSizeArr.push(variants[j].size);
                }
                variantArray.push(variants);
                sizeArray.push(vSizeArr);
                let colors = await sqlQuery(`SELECT color_code, color_name FROM variants WHERE title = '${allProduct[i].title}';`);
                let vColorArr = [];
                for (let k = 0; k < colors.length; k++) {
                    vColorArr.push(colors[k]);
                }
                colorArray.push(vColorArr);
                obj = {
                    id: allProduct[i].id,
                    title: allProduct[i].title,
                    description: allProduct[i].description,
                    price: allProduct[i].price,
                    texture: allProduct[i].texture,
                    wash: allProduct[i].wash,
                    place: allProduct[i].place,
                    note: allProduct[i].note,
                    story: allProduct[i].story,
                    colors: colorArray[i],
                    sizes: sizeArray[i],
                    variants: variantArray[i],
                    main_image: allProduct[i].main_image,
                    images: JSON.parse(imagesArray[i].image_path),
                }
                result.data.push(obj);
            }
        } else {
            for (let i = 0; i < dataPerPage; i++) { // still needs loop if 3 data per page above
                let variants = await sqlQuery(`SELECT color_code, size ,stock FROM variants WHERE title = '${allProduct[i].title}';`);
                let vSizeArr = [];
                for (let j = 0; j < variants.length; j++) {
                    vSizeArr.push(variants[j].size);
                }
                variantArray.push(variants);
                sizeArray.push(vSizeArr);
                let colors = await sqlQuery(`SELECT color_code, color_name FROM variants WHERE title = '${allProduct[i].title}';`);
                let vColorArr = [];
                for (let k = 0; k < colors.length; k++) {
                    vColorArr.push(colors[k]);
                }
                colorArray.push(vColorArr);
                obj = {
                    id: allProduct[i].id,
                    title: allProduct[i].title,
                    description: allProduct[i].description,
                    price: allProduct[i].price,
                    texture: allProduct[i].texture,
                    wash: allProduct[i].wash,
                    place: allProduct[i].place,
                    note: allProduct[i].note,
                    story: allProduct[i].story,
                    colors: colorArray[i],
                    sizes: sizeArray[i],
                    variants: variantArray[i],
                    main_image: allProduct[i].main_image,
                    images: JSON.parse(imagesArray[i].image_path),
                }
                result.data.push(obj);
                result.paging = paging + 1;
            }
        }
        res.send(result);
    } else if (url === "women" || url === "men" || url === "accessories") {
        dataCount = await sqlQuery(`SELECT COUNT(*) FROM product;`);
        dataCount = dataCount[0]["COUNT(*)"];
        pageCount = dataCount % dataPerPage === 0 ? (dataCount / dataPerPage) : (dataCount / dataPerPage) + 1
        if (isNaN(paging)) {
            paging = 0;
        } else if (!isNaN(paging) && paging < pageCount) {
            paging = parseInt(paging);
        }
        allProduct = await sqlQuery(`SELECT * FROM product WHERE category = '${url}' LIMIT ${dataPerPage} OFFSET ${(paging) * dataPerPage};`);
        imagesArray = await sqlQuery(`SELECT image_path FROM images LIMIT ${dataPerPage} OFFSET ${(paging) * dataPerPage};`);
        nextPage = await sqlQuery(`SELECT * FROM product WHERE category = '${url}' LIMIT ${dataPerPage} OFFSET ${(paging + 1) * dataPerPage};`);
        if (nextPage.length === 0) {
            for (let i = 0; i < allProduct.length; i++) {
                let variants = await sqlQuery(`SELECT color_code, size ,stock FROM variants WHERE title = '${allProduct[i].title}';`);
                let vSizeArr = [];
                for (let j = 0; j < variants.length; j++) {
                    vSizeArr.push(variants[j].size);
                }
                variantArray.push(variants);
                sizeArray.push(vSizeArr);
                let colors = await sqlQuery(`SELECT color_code, color_name FROM variants WHERE title = '${allProduct[i].title}';`);
                let vColorArr = [];
                for (let k = 0; k < colors.length; k++) {
                    vColorArr.push(colors[k]);
                }
                colorArray.push(vColorArr);
                obj = {
                    id: allProduct[i].id,
                    title: allProduct[i].title,
                    description: allProduct[i].description,
                    price: allProduct[i].price,
                    texture: allProduct[i].texture,
                    wash: allProduct[i].wash,
                    place: allProduct[i].place,
                    note: allProduct[i].note,
                    story: allProduct[i].story,
                    colors: colorArray[i],
                    sizes: sizeArray[i],
                    variants: variantArray[i],
                    main_image: allProduct[i].main_image,
                    images: JSON.parse(imagesArray[i].image_path),
                }
                result.data.push(obj);
            }
        } else {
            for (let i = 0; i < dataPerPage; i++) {
                let variants = await sqlQuery(`SELECT color_code, size ,stock FROM variants WHERE title = '${allProduct[i].title}';`);
                let vSizeArr = [];
                for (let j = 0; j < variants.length; j++) {
                    vSizeArr.push(variants[j].size);
                }
                variantArray.push(variants);
                sizeArray.push(vSizeArr);
                let colors = await sqlQuery(`SELECT color_code, color_name FROM variants WHERE title = '${allProduct[i].title}';`);
                let vColorArr = [];
                for (let k = 0; k < colors.length; k++) {
                    vColorArr.push(colors[k]);
                }
                colorArray.push(vColorArr);
                obj = {
                    id: allProduct[i].id,
                    title: allProduct[i].title,
                    description: allProduct[i].description,
                    price: allProduct[i].price,
                    texture: allProduct[i].texture,
                    wash: allProduct[i].wash,
                    place: allProduct[i].place,
                    note: allProduct[i].note,
                    story: allProduct[i].story,
                    colors: colorArray[i],
                    sizes: sizeArray[i],
                    variants: variantArray[i],
                    main_image: allProduct[i].main_image,
                    images: JSON.parse(imagesArray[i].image_path),
                }
                result.data.push(obj);
                result.paging = paging + 1;
            }
        }
        res.send(result);
    } else if (url === "search") {
        searchCount = await sqlQuery(`SELECT COUNT(*) FROM product WHERE title LIKE '%${keyword}%';`);
        searchCount = searchCount[0]["COUNT(*)"];
        pageCount = searchCount % dataPerPage === 0 ? (searchCount / dataPerPage) : (searchCount / dataPerPage) + 1

        if (isNaN(paging)) {
            paging = 0;
        } else if (!isNaN(paging) && paging < pageCount) {
            paging = parseInt(paging);
        }
        // title
        allProduct = await sqlQuery(`SELECT * FROM product WHERE title LIKE '%${keyword}%' LIMIT ${dataPerPage} OFFSET ${(paging) * dataPerPage};`);
        if (allProduct.length === 0) {
            res.send("keyword search no result");
        } else {
            imagesArray = await sqlQuery(`SELECT image_path FROM images WHERE title LIKE '%${keyword}%' LIMIT ${dataPerPage} OFFSET ${(paging) * dataPerPage};`);
            console.log(imagesArray)
            nextPage = await sqlQuery(`SELECT * FROM product WHERE title LIKE '%${keyword}%' LIMIT ${dataPerPage} OFFSET ${(paging + 1) * dataPerPage};`);
            if (nextPage.length === 0) {
                for (let i = 0; i < allProduct.length; i++) {
                    let variants = await sqlQuery(`SELECT color_code, size ,stock FROM variants WHERE title = '${allProduct[i].title}';`);
                    let vSizeArr = [];
                    for (let j = 0; j < variants.length; j++) {
                        vSizeArr.push(variants[j].size);
                    }
                    variantArray.push(variants);
                    sizeArray.push(vSizeArr);
                    let colors = await sqlQuery(`SELECT color_code, color_name FROM variants WHERE title = '${allProduct[i].title}';`);
                    let vColorArr = [];
                    for (let k = 0; k < colors.length; k++) {
                        vColorArr.push(colors[k]);
                    }
                    colorArray.push(vColorArr);
                    obj = {
                        id: allProduct[i].id,
                        title: allProduct[i].title,
                        description: allProduct[i].description,
                        price: allProduct[i].price,
                        texture: allProduct[i].texture,
                        wash: allProduct[i].wash,
                        place: allProduct[i].place,
                        note: allProduct[i].note,
                        story: allProduct[i].story,
                        colors: colorArray[i],
                        sizes: sizeArray[i],
                        variants: variantArray[i],
                        main_image: allProduct[i].main_image,
                        images: JSON.parse(imagesArray[i].image_path),
                    }
                    result.data.push(obj);
                }
            } else {
                for (let i = 0; i < dataPerPage; i++) {
                    let variants = await sqlQuery(`SELECT color_code, size ,stock FROM variants WHERE title = '${allProduct[i].title}';`);
                    let vSizeArr = [];
                    for (let j = 0; j < variants.length; j++) {
                        vSizeArr.push(variants[j].size);
                    }
                    variantArray.push(variants);
                    sizeArray.push(vSizeArr);
                    let colors = await sqlQuery(`SELECT color_code, color_name FROM variants WHERE title = '${allProduct[i].title}';`);
                    let vColorArr = [];
                    for (let k = 0; k < colors.length; k++) {
                        vColorArr.push(colors[k]);
                    }
                    colorArray.push(vColorArr);
                    obj = {
                        id: allProduct[i].id,
                        title: allProduct[i].title,
                        description: allProduct[i].description,
                        price: allProduct[i].price,
                        texture: allProduct[i].texture,
                        wash: allProduct[i].wash,
                        place: allProduct[i].place,
                        note: allProduct[i].note,
                        story: allProduct[i].story,
                        colors: colorArray[i],
                        sizes: sizeArray[i],
                        variants: variantArray[i],
                        main_image: allProduct[i].main_image,
                        images: JSON.parse(imagesArray[i].image_path),
                    }
                    result.data.push(obj);
                    result.paging = paging + 1;
                }
            }
            res.send(result);
        }
    } else if (url === "details") {
        // get data from cache
        let cacheDetails = myCache.get(`details${id}`, (err, value) => {
            if (!err) {
                return value
            } else {
                console.log("err");
            }
        });
        if (cacheDetails == undefined) { // got no data, query data from db
            allProduct = await sqlQuery(`SELECT * FROM product WHERE id = ${id}`);
            console.log(allProduct)
            if (allProduct.length === 0) {
                res.send("id search no result");
            } else {
                imagesArray = await sqlQuery(`SELECT image_path FROM images WHERE title = '${allProduct[0].title}';`);
                let variants = await sqlQuery(`SELECT color_code, size ,stock FROM variants WHERE title = '${allProduct[0].title}';`);
                let vSizeArr = [];
                for (let j = 0; j < variants.length; j++) {
                    vSizeArr.push(variants[j].size);
                }
                variantArray.push(variants);
                sizeArray.push(vSizeArr);
                let colors = await sqlQuery(`SELECT color_code, color_name FROM variants WHERE title = '${allProduct[0].title}';`);
                let vColorArr = [];
                for (let k = 0; k < colors.length; k++) {
                    vColorArr.push(colors[k]);
                }
                colorArray.push(vColorArr);
                obj = {
                    id: allProduct[0].id,
                    title: allProduct[0].title,
                    description: allProduct[0].description,
                    price: allProduct[0].price,
                    texture: allProduct[0].texture,
                    wash: allProduct[0].wash,
                    place: allProduct[0].place,
                    note: allProduct[0].note,
                    story: allProduct[0].story,
                    colors: colorArray[0],
                    sizes: sizeArray[0],
                    variants: variantArray[0],
                    main_image: allProduct[0].main_image,
                    images: JSON.parse(imagesArray[0].image_path),
                }
                result.data.push(obj);
                // update cache
                console.log("update cache");
                myCache.set(`details${id}`, result, (err, success) => {
                    if (!err && success) {
                        console.log(`set cache details success = ${success}`);
                    } else {
                        console.log(err);
                        console.log("set cache details fail")
                    }
                });
                console.log("got data from db");
                res.send(result);
            }
        } else {
            console.log("got data from cache");
            res.send(cacheDetails);
        }
    } else {
        res.send("page does not exist.");
    }
    // res.json(data) and res.send(data) will JSON.stringify(data) then send!!
    // if u got a string like "{'name':'john','gender':'male'}" parse it to obj then res.send(obj)/res.send(obj)
});

app.post("/user/profile", async (req, res) => {
    const auth = req.headers.authorization;
    if (auth) {
        let token = auth.slice(7);
        console.log(token)
        let regiUser = await sqlQuery(`SELECT * FROM users WHERE token = '${token}';`);
        if (regiUser.length === 0) {
            res.send({
                data: null,
            });
        } else if (regiUser.length === 1) {
            // token match db user token but need to check if expired
            let tokenExpired = Date.now() > regiUser[0].token_expired ? true : false;
            if (tokenExpired) {
                res.json({
                    data: null,
                });
            } else {
                // token matched and not expired, show user profile
                let user = {
                    id: regiUser[0].regi_id,
                    provider: regiUser[0].provider,
                    name: regiUser[0].name,
                    email: regiUser[0].email,
                    picture: regiUser[0].picture,
                }
                let resObj = {
                    data: {
                        access_token: regiUser[0].token,
                        access_expired: regiUser[0].token_expired,
                        user: user
                    }
                }
                res.json(resObj);
            }
        }
    } else {
        res.json({
            data: null,
        });
    }
});

app.post("/user/signup", async (req, res) => {
    if (req.headers["content-type"] != "application/json") {
        res.send("headers content type must be application/json");
    } else {
        const name = req.body.name; // inputs from front-end
        const email = req.body.email;
        const password = req.body.password;
        // console.log(req.body);
        let registerCheck = await sqlQuery(`SELECT COUNT(*) FROM users WHERE email = '${email}';`);
        if (registerCheck[0]['COUNT(*)'] > 0) {
            const errMsg = {
                errMsg: "信箱已經被註冊了"
            }
            res.send(errMsg);
        } else if (registerCheck[0]['COUNT(*)'] === 0 && req.headers["content-type"] === "application/json") {
            const hashPwd = crypto.createHash("sha256").update(password, "utf8").digest("hex");
            const token = crypto.randomBytes(64).toString("hex");
            const defaultImg = "http://13.59.184.2/default.png";
            const userData = {
                name: name,
                email: email,
                password: hashPwd,
                provider: "native",
                token: token,
                token_expired: Date.now() + 300000, // five min expire time
                picture: defaultImg
            }
            const signUp = await sqlQuery("INSERT INTO users SET ?", userData);
            let regiUser = await sqlQuery(`SELECT * FROM users WHERE email = '${email}';`);
            let user = {
                id: regiUser[0].regi_id,
                provider: regiUser[0].provider,
                name: regiUser[0].name,
                email: regiUser[0].email,
                picture: regiUser[0].picture,
            }
            let resObj = {
                data: {
                    access_token: regiUser[0].token,
                    access_expired: regiUser[0].token_expired,
                    user: user
                }
            }
            res.json(resObj);
        } else {
            res.send("something went wrong");
        }
    }
});

app.post("/user/signin", async (req, res) => {
    if (req.headers["content-type"] != "application/json") {
        res.send("req.headers.content-type must be application/json");
    } else {
        const email = req.body.email; // inputs from front-end, signin don't need name.
        const password = req.body.password;
        const provider = req.body.provider;
        if (provider === "native") {
            const registerCheck = await sqlQuery(`SELECT COUNT(*) FROM users WHERE email = '${email}';`)
            if (registerCheck[0]["COUNT(*)"] === 0) {
                const errMsg = {
                    errMsg: "此信箱未註冊"
                }
                res.send(errMsg);
            } else if (registerCheck[0]["COUNT(*)"] === 1 && req.headers["content-type"] === "application/json") { // signin code here
                const hashPwd = crypto.createHash("sha256").update(password, "utf8").digest("hex");
                let passwordCheck = await sqlQuery(`SELECT email, password FROM users WHERE email = '${email}' AND password = '${hashPwd}'`);
                if (passwordCheck.length === 0) {
                    const errMsg = {
                        errMsg: "密碼錯誤"
                    }
                    res.send(errMsg);
                } else if (passwordCheck.length === 1) {
                    // email and password matched, refresh token
                    const token = crypto.randomBytes(64).toString("hex");
                    const token_expired = Date.now() + 300000 // five min expire time
                    const signIn = await sqlQuery(`UPDATE users SET token = '${token}', token_expired = '${token_expired}' WHERE email = '${email}';`);
                    // console.log(signIn);
                    let regiUser = await sqlQuery(`SELECT * FROM users WHERE email = '${email}';`);
                    let user = {
                        id: regiUser[0].regi_id, // caution
                        provider: regiUser[0].provider,
                        name: regiUser[0].name,
                        email: regiUser[0].email,
                        picture: regiUser[0].picture,
                    }
                    let resObj = {
                        data: {
                            access_token: regiUser[0].token,
                            access_expired: regiUser[0].token_expired,
                            user: user
                        }
                    }
                    console.log("native signin success");
                    res.json(resObj);
                }
            }
        } else if (provider === "facebook") {
            const fbToken = req.body.token; // aquire fb token from req.body
            const url = `https://graph.facebook.com/me?fields=id,name,email&access_token=${fbToken}`;
            await request(url, async (error, response, body) => { // request user info
                if (!error && response.statusCode == 200) {
                    // this user has logged into fb, and is a verified user.
                    const fbId = JSON.parse(body).id; // not sure if required
                    const fbName = JSON.parse(body).name;
                    const fbEmail = JSON.parse(body).email;
                    // see if user email registered in db
                    const registerCheck = await sqlQuery(`SELECT COUNT(*) FROM users WHERE email = '${fbEmail}';`);
                    if (registerCheck[0]["COUNT(*)"] === 0) {
                        // this email hasn't registered in db yet, do regi.
                        const token = crypto.randomBytes(64).toString("hex");
                        const defaultImg = "http://13.59.184.2/default.png";
                        const userData = {
                            name: fbName,
                            email: fbEmail,
                            token: token, // replace fbToken
                            token_expired: Date.now() + 300000, // expired in 5 mins
                            provider: "facebook",
                            picture: defaultImg,
                        }
                    } else if (registerCheck[0]["COUNT(*)"] === 1) {
                        // this email has already registered in db, do signin.
                        // signin refreshes token
                        const token = crypto.randomBytes(64).toString("hex");
                        const token_expired = Date.now() + 300000 // five min expire time
                        const signIn = await sqlQuery(`UPDATE users SET token = '${token}', token_expired = '${token_expired}' WHERE email = '${fbEmail}';`);
                    }
                    // This email is now registered
                    // construct res obj
                    const regiUser = await sqlQuery(`SELECT * FROM users WHERE email = '${fbEmail}';`); // async issue
                    let user = {
                        id: regiUser[0].regi_id, // caution
                        provider: regiUser[0].provider,
                        name: regiUser[0].name,
                        email: regiUser[0].email,
                        picture: regiUser[0].picture,
                    }
                    let resObj = {
                        data: {
                            access_token: regiUser[0].token,
                            access_expired: regiUser[0].token_expired,
                            user: user
                        }
                    }
                    console.log("facebook signin success");
                    res.json(resObj);
                } else {
                    console.log(error);
                }
            });

        } else {
            res.send("wrong content-type or invalid token / provider");
        }
        // fb login note
        // get fb access token
        // make request to fb (require request module)
        // get user's name and email 
        // if email hasn't registered INSERT INTO db name, email, token, token expire, provider
        // if email registered update db token, token expire time, provider
    }
});

app.post("/order/checkout", async (req, res) => {
    const auth = req.headers.authorization;
    const contentType = req.headers["content-type"];
    if (contentType === "application/json") { // verify data
        // console.log(req.body);
        let signedIn;
        if (auth) {
            const token = auth.slice(7);
            const regiUser = await sqlQuery(`SELECT * FROM users WHERE token = '${token}';`);
            if (regiUser.length === 0) {
                // token doesn't match proceed to not-signed-in user checkout
                signedIn = false;
            } else if (regiUser.length === 1) {
                // token match db user token but need to check if expired
                let tokenExpired = Date.now() > regiUser[0].token_expired ? true : false;
                if (tokenExpired) {
                    // token matched but expired proceed to not-signed-signed user checkout
                    signedIn = false;
                } else {
                    // token matched and not expired, user status = signed-in
                    signedIn = true;
                }
            }
        } else {
            signedIn = false;
        }
        /*** from shopping cart ***/
        const { // aquire data from front-end
            // prime: prime, // prime token (str)
            order: order, // order detail (obj)
        } = req.body;
        const {
            recipient: recipient, // user info (obj)
            list: list, // purchase list (arr)
        } = order;
        /*** from shopping cart ***/

        /*** from get prime ***/
        const x_api_key = req.headers["x-api-key"]; // optional
        const {
            partner_key: partnerKey,
            prime: prime,
            amount: amount,
            merchant_id: merchantId,
            details: details,
            cardholder: cardHolder,
        } = req.body;
        const {
            phone_number: phoneNumber,
            name: name,
            email: email,
            zip_code: zipCode,
            address: address,
            national_id: nationadId,
        } = cardHolder;
        /*** from get prime ***/

        // create an unpaid order record in one mega table
        const orderData = {
            shipping: order.shipping,
            payment: order.payment,
            subtotal: order.subtotal,
            freight: order.freight,
            total: order.total,
            recip_name: order.recipient.name,
            recip_phone: order.recipient.phone,
            recip_email: order.recipient.email,
            recip_address: order.recipient.address,
            recip_time: order.recipient.time,
            list: JSON.stringify(order.list),
            signed_in: signedIn,
        }
        const invoice = await sqlQuery(`INSERT INTO orders SET ?`, orderData); // unpaid order recorded in db
        // send prime and order to TapPay for payment processing (request module)
        const paymentData = {
            prime: prime,
            partner_key: "partner_PHgswvYEk4QY6oy3n8X3CwiQCVQmv91ZcFoD5VrkGFXo8N7BFiLUxzeG", // partnerKey,
            merchant_id: "AppWorksSchool_CTBC", // merchantId,
            details: details,
            amount: amount,
            cardholder: cardHolder,
            remember: false
        }
        const options = {
            url: "https://sandbox.tappaysdk.com/tpc/payment/pay-by-prime",
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-api-key": x_api_key, // optional
            },
            json: paymentData,
        }
        await request(options, (error, response, body) => {
            if (!error && response.statusCode == 200) {
                // receive paymant result from TapPay
                if (body.status === 0) {
                    // if success, payment record in db, order update to paid, record tappay response for future use (refund or something)
                    const tapPayRes = JSON.stringify(body);
                    sqlQuery(`UPDATE orders SET pay_status = 'paid', tap_pay_res = '${tapPayRes}' WHERE order_id = '${invoice.insertId}';`);
                    const resObj = {
                        data: {
                            number: invoice.insertId,
                        }
                    }
                    console.log("paid")
                    res.send(resObj);
                } else {
                    // failed, this body obj contains status code and msg
                    console.log("payment failed")
                    res.send(body);
                }
            } else {
                // request fail, send error message to front end
                console.error(error);
            }
        });
    } else {
        res.send("wrong content-type or invalid request body");
    }
});

/*** functions ***/
function sqlQuery(query, data) {
    return new Promise((resolve, reject) => {
        pool.query(query, data, (err, result) => {
            if (err) {
                reject(err);
            } else {
                resolve(result);
            }
        });
    });
};

function processImages(imageArray) {
    let imagePathArray = [];
    for (let i = 0; i < imageArray.length; i++) {
        imagePathArray.push(convertFilePath(imageArray[i].location));
    }
    return JSON.stringify(imagePathArray);
}

function bucketImg(imageArray) {
    let imagePathArray = [];
    for (let i = 0; i < imageArray.length; i++) {
        imagePathArray.push(imageArray[i].location);
    }
    return JSON.stringify(imagePathArray);
}

function convertFilePath(fileName) {
    let localPrefix = "localhost:3000/uploads/";
    // let domainPrefix = "https://13.59.184.2/uploads/";
    let domainPrefix = ""; // TODO: S3 need no prefix
    return domainPrefix + fileName
}

app.listen(port, function () {
    console.log(`Listening on port ${port}!`);
});

/*** while use pm2 to run script in background, restart pm2 processes every deploy ***/
/*** my guess: pm2 run scripts in memory not actual file in the disk ***/