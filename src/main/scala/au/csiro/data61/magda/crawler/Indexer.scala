package au.csiro.data61.magda.crawler

import java.net.URL

import scala.util.Failure
import scala.util.Success

import akka.actor.Actor
import akka.actor.ActorRef
import au.csiro.data61.magda.model.temporal._
import au.csiro.data61.magda.model.misc._
import au.csiro.data61.magda.model.misc.Protocols._
import au.csiro.data61.magda.search.SearchProvider
import akka.stream.ActorMaterializer
import akka.actor.ActorLogging

/**
 * @author Foat Akhmadeev
 *         17/01/16
 */
class Indexer(supervisor: ActorRef) extends Actor with ActorLogging {
  implicit val ec = context.dispatcher
  implicit val system = context.system
  implicit val materializer = ActorMaterializer.create(context)
  val searchProvider: SearchProvider = SearchProvider()

  // On startup, check that the index isn't empty (as it would be on first boot or after an index schema upgrade)
  searchProvider.needsReindexing().onComplete {
    case Success(needsReindexing) => needsReindexing match {
      case true  => supervisor ! NeedsReIndexing
      case false => // Index isn't empty so it's all good :) 
    }
    case Failure(e) => {
      log.error(e, "Failed to determine whether the index needs reindexing - this might mean that there's out-of-date or no data to search on")
    }
  }

  def receive: Receive = {
    case Index(source, dataSets) =>
      searchProvider.index(source, dataSets) onComplete {
        case Success(_)      => supervisor ! IndexFinished(dataSets, source)
        case Failure(reason) => supervisor ! IndexFailed(source, reason)
      }
  }

  @throws[Exception](classOf[Exception])
  override def postStop(): Unit = {
    super.postStop()
    //    store.foreach(println)
    //    println(store.size)
  }
}