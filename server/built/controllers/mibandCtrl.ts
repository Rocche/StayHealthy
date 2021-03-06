import { Request } from "express"
import { Miband } from "../models/models"
import { TableCtrl } from "./tableCtrl"
import { CustomError } from "../models/customError"
import { PythonShell } from 'python-shell'
import { ENODEV, POINT_CONVERSION_COMPRESSED } from "constants";
import * as fs from 'fs';

export class MibandCtrl extends TableCtrl {

    public async getData(req: Request): Promise<any> {

        this.sql = 'SELECT * FROM miband WHERE (patient_ssn = $1 AND (timestamp >= $2 AND timestamp <= $3)) ORDER BY timestamp ASC'
        this.params = [
            req.query.patient_ssn,
            req.query.dayFrom,
            req.query.dayTo
        ]
        this.result = await this.dbManager.getQuery(this.sql, this.params)

        if (this.result.rowCount > 0) {
            let mibandArray = []
            for (let row of this.result.rows) {
                let miband = new Miband()
                miband.patient_ssn = row.patient_ssn
                miband.timestamp = row.timestamp
                miband.activity = row.activity
                miband.intensity = row.intensity
                miband.heart_rate = row.heart_rate
                miband.is_sleeping = row.is_sleeping
                mibandArray.push(miband)
            }
            this.result = mibandArray
        }
        return this.result
    }

    public async postData(req: Request): Promise<any> {        
        // get the user's last fetch date from the db
        var data: any[] = []
        var newLastFetchDate = new Date()
        var currentLastFetchDate = (await this.getLastFetchDate(req)).rows[0].last_fetch_date
        newLastFetchDate = currentLastFetchDate

        this.sql = 'INSERT INTO miband ( patient_ssn, timestamp, activity, intensity, heart_rate, is_sleeping ) VALUES ($1,$2,$3,$4,$5,$6)'
        for (let element of req.body) {
            // add only those element whoose date is more recente then the last last fetch date
            if (new Date(element.timestamp) > newLastFetchDate) {
                // console.log(element.timestamp)
                this.params = [
                    req.query.patient_ssn,
                    element.timestamp,
                    element.activity,
                    element.intensity,
                    element.heart_rate
                ]
                data.push(this.params)
                // save newLastFetchDate to update the user's last fetch date on the database
                newLastFetchDate = new Date(element.timestamp)
            }
        }
        // if no data was added to the array, return alert message
        if (!(data[0])) {
            this.error.name = "DATA ERROR"
            this.error.details = ("No data more recent than: " + currentLastFetchDate + ".")
            return this.error
        }
        data = await this.PredictSleep(req, data)
        // else, proceed with the query
        this.result = await this.dbManager.postData(this.sql, data)
        console.log(this.result);
        await this.handleLastFetchDate(this.result, req, currentLastFetchDate, newLastFetchDate)

        return this.result
    }

    public async PredictSleep(req: Request, data: any[]): Promise<any[]> {
        var file_dir = "./"
        var file_name = req.query.patient_ssn.toString()
        var file_ext = ".json"
        var file_path = file_dir + file_name + file_ext
        fs.writeFile(file_path,JSON.stringify(req.body),(err)=>{
            if (err) {
                console.log(err)
                throw err
            }
        })
        // define python shell options
        var options = {
            args:
            [
                process.env.RFMODELPATH,
                file_path,
            ],
            pythonPath: process.env.PYTHONPATH,
            // scriptPath: './',
        }
        // define python shell variable
        var pyshell = new PythonShell(process.env.RFSCRIPTPATH, options);
        // array used to collect predicted sleeping modes
        var predictions: any[] = [];
        // listen to every message printed from python script
        // and append the message to the predictions array
        pyshell.on('message', function (result) {
            result = JSON.parse(result);
            //console.log(result)
            result.forEach(element => {
                predictions.push(element.is_sleeping);
            });
        })
        // once the script has ended -> append predictions to data and return
        return new Promise((resolve, reject) => {
            pyshell.end((err,code,signal)=> {
                fs.unlink(file_path, (err)=>{
                    if (err) throw err
                })
                // append predictions to data (from req.body)
                for (let i = 0; i < data.length; i++) {
                    data[i][5] = predictions[i]
                }
                // resolve -> return result
                resolve(data)
                // reject -> return error
                if (err){
                    console.log(err);
                    reject(err);
                    
                } 
            })
        })
        
    }

    public async handleLastFetchDate(result: any, req: Request, currentLastFetchDate: Date, newLastFetchDate: Date) {
        // if no error is returned by the query, then update the user's last fetch date on the database and return the new last fetch date
        if (!(result instanceof Error || result instanceof CustomError)) {
            console.log('currentLastFetchDate: ', currentLastFetchDate)
            result = await this.putLastFetchDate(req.query.patient_ssn, result)
            console.log("newLastFetchDate: ", newLastFetchDate)
            if (!(result instanceof Error || result instanceof CustomError)) { result = newLastFetchDate }
            // else, remoove the data on the database starting from the current last fetch date, and return the current last fetch date
        } else {
            result = await this.deleteFromLastFetchDate(req.query.patient_ssn, currentLastFetchDate)
            if (!(result instanceof Error || result instanceof CustomError)) { result = currentLastFetchDate }
        }
    }

    public async putLastFetchDate(patient_ssn: string, newLastFetchDate: Date): Promise<string> {
        this.sql = 'UPDATE patients SET last_fetch_date = $1 WHERE patient_ssn = $2'
        this.params = [
            newLastFetchDate,
            patient_ssn
        ]
        this.result = await this.dbManager.postQuery(this.sql, this.params)
        if (!(this.result instanceof Error || this.result instanceof CustomError)) { this.result = new Date(newLastFetchDate) }
        return this.result
    }

    public async getLastFetchDate(req: Request): Promise<any> {
        this.sql = 'SELECT last_fetch_date FROM patients WHERE patient_ssn = $1'
        this.params = [
            req.query.patient_ssn
        ]
        this.result = await this.dbManager.getQuery(this.sql, this.params)
        return this.result
    }

    public async deleteFromLastFetchDate(patient_ssn: string, last_fetch_date: Date): Promise<any> {
        this.sql = 'DELETE FROM miband WHERE patient_ssn = $1 AND timestamp > $2'
        this.params = [
            patient_ssn,
            last_fetch_date
        ]
        this.result = await this.dbManager.deleteQuery(this.sql, this.params)
        return this.result
    }

}